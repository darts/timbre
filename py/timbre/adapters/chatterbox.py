"""Resemble AI Chatterbox adapter.

Chatterbox performs zero-shot cloning directly from a reference clip. Its
`Conditionals` payload can be prepared once and reused across chunks, matching
the app's cached-prompt flow.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import numpy as np

from timbre.adapters.base import CloneResult, TTSAdapter
from timbre.registry import get


class ChatterboxAdapter(TTSAdapter):
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self._wrapper: Any = None
        self._requested_device: str = "cpu"
        self._device: str = "cpu"
        self._device_detail: str = "not_loaded"
        self._warnings: list[str] = []
        self._info = get(model_id)
        self._variant = (self._info.raw or {}).get("variant", "turbo")
        self.sample_rate = int(self._info.sample_rate)

    def load(self, device: str) -> None:
        if self._wrapper is not None:
            return
        try:
            import torch
            if self._variant == "turbo":
                from chatterbox.tts_turbo import ChatterboxTurboTTS as Model
            else:
                from chatterbox.tts import ChatterboxTTS as Model
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                "Chatterbox dependencies failed to import in the active backend: "
                f"{type(e).__name__}: {e}. Open the Models tab and install/repair "
                "Chatterbox."
            ) from e

        self._requested_device = device
        self._warnings = []
        resolved = self._resolve_torch_device(device)
        if resolved != device:
            self._warnings.append(
                f"requested device '{device}' is unavailable; using '{resolved}'"
            )

        self._wrapper = Model.from_pretrained(device=resolved)
        self._device = str(getattr(self._wrapper, "device", resolved))
        self._device_detail = f"full_{self._device}_{self._variant}"
        self.sample_rate = int(getattr(self._wrapper, "sr", self.sample_rate))

        # Keep the import live for PyInstaller/Tauri resource scanners and
        # to make it clear torch is intentionally part of the load path.
        _ = torch

    def _default_exaggeration(self) -> float:
        return 0.0 if self._variant == "turbo" else 0.5

    def _ensure_conditionals(self, payload: Any, exaggeration: float) -> Any:
        t3 = getattr(payload, "t3", None)
        gen = getattr(payload, "gen", None)
        if t3 is None or not isinstance(gen, dict):
            raise ValueError("cached Chatterbox prompt is missing conditionals")

        import torch
        emotion = getattr(t3, "emotion_adv", None)
        if not torch.is_tensor(emotion):
            t3.emotion_adv = torch.full(
                (1, 1, 1),
                float(exaggeration),
                dtype=torch.float32,
                device=self._device,
            )
            print(
                "[timbre] Chatterbox cached prompt was missing emotion_adv; "
                "patched it in memory",
                file=sys.stderr,
                flush=True,
            )
        return payload

    @staticmethod
    def _replace_conditionals(target: Any, source: Any) -> None:
        if target is None or source is None:
            return
        try:
            target.t3 = source.t3
            target.gen = source.gen
        except Exception:  # noqa: BLE001
            pass

    def deserialize_payload(self, data: bytes, device: str) -> Any:
        payload = super().deserialize_payload(data, device)
        return self._ensure_conditionals(payload, self._default_exaggeration())

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
        self._wrapper.prepare_conditionals(str(ref_audio_path))
        self._wrapper.conds = self._ensure_conditionals(
            self._wrapper.conds,
            self._default_exaggeration(),
        )
        return CloneResult(payload=self._wrapper.conds, sample_rate=self.sample_rate)

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
        raw_exaggeration = params.get("exaggeration")
        exaggeration = (
            self._default_exaggeration()
            if raw_exaggeration is None
            else float(raw_exaggeration)
        )
        kwargs: dict[str, Any] = {"text": text}
        for k in ("top_p", "temperature", "repetition_penalty"):
            if k in params and params[k] is not None:
                kwargs[k] = params[k]
        if self._variant == "turbo":
            if params.get("top_k") is not None:
                kwargs["top_k"] = params["top_k"]
        else:
            for k in ("min_p", "cfg_weight", "exaggeration"):
                if k in params and params[k] is not None:
                    kwargs[k] = params[k]

        used_cached_payload = False
        refresh_cached_payload = False
        can_rebuild_from_reference = ref_audio_path.exists() and ref_audio_path.is_file()
        if cached_payload is not None:
            try:
                self._wrapper.conds = self._ensure_conditionals(
                    cached_payload,
                    exaggeration,
                )
                used_cached_payload = True
            except ValueError as e:
                print(
                    f"[timbre] Chatterbox cached prompt is invalid; rebuilding "
                    f"from reference audio: {e}",
                    file=sys.stderr,
                    flush=True,
                )
                if not can_rebuild_from_reference:
                    raise RuntimeError(
                        "cached Chatterbox prompt is invalid and no reference "
                        "audio is available"
                    ) from e
                kwargs["audio_prompt_path"] = str(ref_audio_path)
                refresh_cached_payload = True
        else:
            kwargs["audio_prompt_path"] = str(ref_audio_path)

        try:
            wav = self._wrapper.generate(**kwargs)
        except TypeError as e:
            if used_cached_payload and "nonetype" in str(e).lower():
                print(
                    "[timbre] Chatterbox cached prompt caused a NoneType error; "
                    "rebuilding from reference audio",
                    file=sys.stderr,
                    flush=True,
                )
                if not can_rebuild_from_reference:
                    raise RuntimeError(
                        "cached Chatterbox prompt failed and no reference audio "
                        "is available"
                    ) from e
                self._wrapper.conds = None
                retry_kwargs = dict(kwargs)
                retry_kwargs["audio_prompt_path"] = str(ref_audio_path)
                try:
                    wav = self._wrapper.generate(**retry_kwargs)
                    refresh_cached_payload = True
                except Exception as retry_err:  # noqa: BLE001
                    raise RuntimeError(
                        "Chatterbox generation failed after rebuilding the "
                        f"voice prompt ({len(text)} chars on {self._device}): "
                        f"{type(retry_err).__name__}: {retry_err}"
                    ) from retry_err
            else:
                raise RuntimeError(
                    f"Chatterbox generation failed ({len(text)} chars on "
                    f"{self._device}): {type(e).__name__}: {e}"
                ) from e
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"Chatterbox generation failed ({len(text)} chars on "
                f"{self._device}): {type(e).__name__}: {e}"
            ) from e
        if refresh_cached_payload:
            self._replace_conditionals(
                cached_payload,
                getattr(self._wrapper, "conds", None),
            )
        if hasattr(wav, "detach"):
            wav = wav.detach()
        if hasattr(wav, "cpu"):
            wav = wav.cpu().numpy()
        return np.asarray(wav, dtype=np.float32).reshape(-1), int(self.sample_rate)
