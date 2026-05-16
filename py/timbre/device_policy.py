"""Device selection and accelerator fallback policy."""
from __future__ import annotations

import sys
from typing import Any


def best_available_device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def accelerator_retry_reason(
    error: Exception,
    requested_device: str,
    adapter: Any | None = None,
) -> str | None:
    if requested_device == "cpu":
        return None

    text = f"{type(error).__name__}: {error}"
    lower = text.lower()
    if requested_device == "mps":
        terms = (
            "mpsgraph",
            "mps.matmul",
            "mps backend",
            "mps device",
            "mps tensor",
            "metal",
            "metalperformance",
            "output channels",
            "65536",
            "invalid buffer size",
            "placeholder storage",
            "not implemented for 'mps'",
            "not implemented for mps",
            "not implemented for the mps",
            "not currently implemented for the mps device",
            "unsupported device type mps",
        )
    elif requested_device == "cuda":
        terms = (
            "cuda",
            "cublas",
            "cudnn",
            "cusolver",
            "illegal memory access",
            "device-side assert",
            "out of memory",
            "not implemented for 'cuda'",
            "not implemented for cuda",
            "unsupported device type cuda",
        )
    else:
        return None

    if any(term in lower for term in terms):
        return text
    return None


def log_cpu_handoff(
    *,
    context: str,
    model_id: str,
    requested_device: str,
    reason: str,
) -> None:
    print(
        f"[timbre] Accelerator handoff to CPU: context={context} "
        f"model={model_id} requested={requested_device} reason={reason}",
        file=sys.stderr,
        flush=True,
    )


def device_label(device: str) -> str:
    if device == "cuda":
        return "CUDA"
    if device == "mps":
        return "MPS"
    return device.upper()
