"""Reference-clip transcription via faster-whisper.

Used to auto-fill the transcript field when adding a voice. faster-whisper
loads its weights through huggingface_hub, so they land in our app-data
models cache (HF_HOME is already pointed there in `hfcache.py`).

The model is held in a module-level singleton — voice clips are short, the
user will likely transcribe several in a row, and reloading is wasteful."""
from __future__ import annotations

import importlib.util
import threading
from typing import Any

_LOCK = threading.Lock()
_MODEL: Any = None
_MODEL_NAME: str | None = None

# `base` is the sweet spot for short, clean voice-cloning reference clips:
# multilingual, ~145MB on disk, transcribes a 10s clip in a couple of
# seconds on CPU. Override later with a settings toggle if needed.
_DEFAULT_MODEL = "base"


def is_available() -> bool:
    """True if `faster_whisper` is importable in the active venv."""
    importlib.invalidate_caches()
    return importlib.util.find_spec("faster_whisper") is not None


def _resolve_device_and_compute() -> tuple[str, str]:
    """Pick the safest CTranslate2 backend for the host. CTranslate2 doesn't
    support MPS or ROCm, so Apple Silicon and AMD/ROCm hosts fall back to CPU
    int8 — fast enough for short reference clips."""
    try:
        import torch  # noqa: F401
        # ROCm/HIP wheels expose `torch.cuda.is_available() == True` but the
        # CTranslate2 runtime can't talk to HIP. Force CPU under HIP.
        if getattr(torch.version, "hip", None) is not None:
            return "cpu", "int8"
        if torch.cuda.is_available():
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def _load(model_name: str):
    global _MODEL, _MODEL_NAME
    with _LOCK:
        if _MODEL is not None and _MODEL_NAME == model_name:
            return _MODEL
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        device, compute_type = _resolve_device_and_compute()
        _MODEL = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
        )
        _MODEL_NAME = model_name
    return _MODEL


def transcribe(
    audio_path: str,
    *,
    language: str | None = None,
    model_name: str = _DEFAULT_MODEL,
) -> dict[str, Any]:
    if not is_available():
        raise RuntimeError(
            "faster-whisper is not installed in the active backend. "
            "Reinstall the backend from Settings to enable auto-transcription."
        )
    model = _load(model_name)
    segments, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=5,
        vad_filter=False,  # short clean clips; skipping VAD avoids onnxruntime.
    )
    parts: list[str] = []
    seg_list: list[dict[str, Any]] = []
    for s in segments:
        parts.append(s.text)
        seg_list.append({"start": s.start, "end": s.end, "text": s.text})
    return {
        "text": "".join(parts).strip(),
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": seg_list,
    }
