"""Qwen3-TTS Base adapter.

Voice cloning is a two-step process in qwen-tts:

  1. `create_voice_clone_prompt(ref_audio, ref_text, x_vector_only_mode)`
     encodes the reference clip into `VoiceClonePromptItem`s — one per
     speaker. With a transcript we use ICL mode (richer conditioning);
     without one we fall back to x-vector-only.

  2. `generate_voice_clone(text, voice_clone_prompt=items)` produces the
     actual audio. Returns `(List[np.ndarray], sample_rate)`.

We expose step 1 via `clone()` so server.py can build the prompt once per
synthesis and reuse it across all chunks — encoding the reference is the
slowest non-generation step.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from timbre.adapters.base import CloneResult, TTSAdapter
from timbre.registry import get


_QWEN_LANGUAGE_BY_CODE = {
    "zh": "chinese",
    "en": "english",
    "fr": "french",
    "de": "german",
    "it": "italian",
    "ja": "japanese",
    "ko": "korean",
    "pt": "portuguese",
    "ru": "russian",
    "es": "spanish",
    "auto": "auto",
}


class Qwen3Adapter(TTSAdapter):
    sample_rate = 24000

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self._wrapper: Any = None  # qwen_tts.Qwen3TTSModel instance
        self._requested_device: str = "cpu"
        self._device: str = "cpu"
        self._device_detail: str = "not_loaded"
        self._warnings: list[str] = []
        self._info = get(model_id)

    def load(self, device: str) -> None:
        if self._wrapper is not None:
            return
        import sys
        import torch
        try:
            from qwen_tts import Qwen3TTSModel  # type: ignore[import-not-found]
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                "Qwen3-TTS dependencies failed to import in the active backend: "
                f"{type(e).__name__}: {e}. Open the Models tab and install/repair "
                "Qwen3-TTS."
            ) from e

        self._requested_device = device
        self._warnings = []
        resolved = self._resolve_torch_device(device)
        if resolved != device:
            self._warnings.append(
                f"requested device '{device}' is unavailable; using '{resolved}'"
            )

        self._device = resolved
        self._device_detail = f"full_{resolved}"
        # bf16 has the best CUDA throughput; CPU stays in fp32 for numerical
        # headroom on long generations.
        dtype: Any = torch.bfloat16 if resolved == "cuda" else torch.float32
        attn_implementation = "eager" if resolved == "mps" else "sdpa"
        if resolved == "mps":
            print(
                "[timbre] Qwen3-TTS: full MPS load with eager attention.",
                file=sys.stderr,
                flush=True,
            )

        self._wrapper = Qwen3TTSModel.from_pretrained(
            self._info.hf_repo,
            device_map=resolved,
            dtype=dtype,
            attn_implementation=attn_implementation,
        )

    def unload(self) -> None:
        if self._wrapper is None:
            return
        try:
            import torch
            del self._wrapper
            self._wrapper = None
            if self._device == "cuda":
                torch.cuda.empty_cache()
            elif self._device == "mps":
                torch.mps.empty_cache()
        except Exception:  # noqa: BLE001
            self._wrapper = None

    def memory_snapshot(self) -> dict[str, Any]:
        try:
            import torch
        except Exception:  # noqa: BLE001
            return {}

        out: dict[str, Any] = {}
        if torch.cuda.is_available():
            out["cuda_allocated_bytes"] = int(torch.cuda.memory_allocated())
            out["cuda_reserved_bytes"] = int(torch.cuda.memory_reserved())
        mps = getattr(torch, "mps", None)
        if mps is not None:
            for key, attr in (
                ("mps_allocated_bytes", "current_allocated_memory"),
                ("mps_driver_allocated_bytes", "driver_allocated_memory"),
                ("mps_recommended_max_bytes", "recommended_max_memory"),
            ):
                fn = getattr(mps, attr, None)
                if callable(fn):
                    try:
                        out[key] = int(fn())
                    except Exception:  # noqa: BLE001
                        pass
        return out

    def clone(self, ref_audio_path: Path, ref_transcript: str | None) -> CloneResult | None:
        if self._wrapper is None:
            raise RuntimeError("model is not loaded; call load(device) first")
        # ICL mode requires a transcript. Without one, fall back to
        # x-vector-only (speaker timbre only, no prosody priors).
        x_vector_only = not (ref_transcript and ref_transcript.strip())
        prompt_items = self._wrapper.create_voice_clone_prompt(
            ref_audio=str(ref_audio_path),
            ref_text=ref_transcript if not x_vector_only else None,
            x_vector_only_mode=x_vector_only,
        )
        return CloneResult(payload=prompt_items, sample_rate=self.sample_rate)

    def synthesize(
        self,
        text: str,
        ref_audio_path: Path,
        ref_transcript: str | None,
        *,
        cached_payload: Any | None = None,
        seed: int | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, int]:
        if self._wrapper is None:
            raise RuntimeError("model is not loaded; call load(device) first")
        import torch
        if seed is not None:
            torch.manual_seed(seed)

        params = params or {}
        kwargs: dict[str, Any] = {"text": text}
        if "language" in params and params["language"]:
            raw_language = str(params["language"]).strip().lower()
            kwargs["language"] = _QWEN_LANGUAGE_BY_CODE.get(raw_language, raw_language)
        for k in ("top_p", "top_k", "temperature", "repetition_penalty", "max_new_tokens"):
            if k in params and params[k] is not None:
                kwargs[k] = params[k]

        if cached_payload is not None:
            kwargs["voice_clone_prompt"] = cached_payload
        else:
            x_vec = not (ref_transcript and ref_transcript.strip())
            kwargs["ref_audio"] = str(ref_audio_path)
            kwargs["ref_text"] = ref_transcript if not x_vec else None
            kwargs["x_vector_only_mode"] = x_vec

        wavs, fs = self._wrapper.generate_voice_clone(**kwargs)
        wav = wavs[0] if isinstance(wavs, list) else wavs
        if hasattr(wav, "cpu"):
            wav = wav.cpu().numpy()
        return np.asarray(wav, dtype=np.float32).reshape(-1), int(fs)
