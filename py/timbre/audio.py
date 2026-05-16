"""Tiny audio helpers. Keeps adapters from each writing their own WAV code."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf


def to_mono(samples: np.ndarray) -> np.ndarray:
    arr = np.asarray(samples, dtype=np.float32)
    if arr.ndim == 0:
        return arr.reshape(1)
    if arr.ndim == 1:
        return np.ascontiguousarray(arr)

    arr = np.squeeze(arr)
    if arr.ndim == 1:
        return np.ascontiguousarray(arr)
    if arr.ndim == 2:
        # soundfile returns frame-major audio: (frames, channels). The second
        # branch keeps us tolerant of channel-major arrays returned by model code.
        if arr.shape[1] <= 8:
            return np.ascontiguousarray(arr.mean(axis=1))
        if arr.shape[0] <= 8:
            return np.ascontiguousarray(arr.mean(axis=0))
        return np.ascontiguousarray(arr.mean(axis=1))

    return np.ascontiguousarray(arr.reshape(-1))


def write_wav(
    path: Path | str,
    samples: np.ndarray,
    sample_rate: int,
    *,
    mono: bool = False,
) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = to_mono(samples) if mono else np.asarray(samples)
    if arr.ndim > 1:
        arr = arr.squeeze()
    if arr.ndim > 2:
        arr = to_mono(arr)
    arr = np.clip(arr, -1.0, 1.0).astype(np.float32)
    sf.write(str(path), arr, sample_rate, subtype="PCM_16")


def read_wav(path: Path | str) -> tuple[np.ndarray, int]:
    arr, sr = sf.read(str(path), always_2d=False)
    return arr.astype(np.float32), int(sr)


def prepare_reference_wav(
    source_path: Path | str,
    destination_path: Path | str,
    *,
    min_seconds: float = 3.0,
    max_seconds: float = 15.0,
) -> tuple[int, int]:
    samples, sr = read_wav(source_path)
    mono = to_mono(samples)
    if sr <= 0 or len(mono) == 0:
        raise ValueError("reference clip has no readable audio samples")

    duration_seconds = len(mono) / sr
    if duration_seconds < min_seconds:
        raise ValueError(
            f"reference clip is too short ({duration_seconds:.1f}s); "
            f"use {min_seconds:.0f}-{max_seconds:.0f}s of clean speech"
        )
    if duration_seconds > max_seconds:
        raise ValueError(
            f"reference clip is too long ({duration_seconds:.1f}s); "
            f"use {min_seconds:.0f}-{max_seconds:.0f}s of clean speech"
        )

    write_wav(destination_path, mono, sr, mono=True)
    return sr, int(duration_seconds * 1000)


def concat_with_crossfade(paths: list[Path | str], crossfade_ms: int = 10) -> tuple[np.ndarray, int]:
    """Concatenate WAVs with a short equal-power crossfade at boundaries."""
    if not paths:
        return np.zeros(0, dtype=np.float32), 24000
    chunks = [read_wav(p) for p in paths]
    sr = chunks[0][1]
    if any(c[1] != sr for c in chunks):
        raise ValueError("crossfade requires matching sample rates")
    fade_n = max(1, int(sr * crossfade_ms / 1000))
    out = chunks[0][0].copy()
    for samples, _ in chunks[1:]:
        if len(out) < fade_n or len(samples) < fade_n:
            out = np.concatenate([out, samples])
            continue
        fade_in = np.sqrt(np.linspace(0.0, 1.0, fade_n, dtype=np.float32))
        fade_out = np.sqrt(np.linspace(1.0, 0.0, fade_n, dtype=np.float32))
        tail = out[-fade_n:] * fade_out
        head = samples[:fade_n] * fade_in
        out = np.concatenate([out[:-fade_n], tail + head, samples[fade_n:]])
    return out, sr
