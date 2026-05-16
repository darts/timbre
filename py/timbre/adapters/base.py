"""Adapter ABC. All v1 models share this contract; differences (e.g. whether
clone() returns a persistable embedding) are surfaced via the return value of
clone() — adapters that have nothing to persist return None."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


@dataclass
class CloneResult:
    """What clone() yields. payload is an opaque Python object that the
    adapter knows how to (un)pickle and use as a conditioning shortcut.
    None means the adapter re-conditions from the raw reference each call."""
    payload: Any
    sample_rate: int


class TTSAdapter(ABC):
    model_id: str
    sample_rate: int

    @abstractmethod
    def load(self, device: str) -> None: ...

    @abstractmethod
    def unload(self) -> None: ...

    def clone(self, ref_audio_path: Path, ref_transcript: str | None) -> CloneResult | None:
        """Optional — return a persistable payload if the model supports it."""
        return None

    def memory_snapshot(self) -> dict[str, Any]:
        """Best-effort accelerator memory counters for diagnostics."""
        return {}

    def diagnostics(self) -> dict[str, Any]:
        """Model-agnostic device placement details surfaced to the UI."""
        resolved = getattr(self, "_device", None)
        return {
            "requested_device": getattr(self, "_requested_device", None),
            "resolved_device": resolved,
            "device_detail": getattr(self, "_device_detail", resolved),
            "warnings": getattr(self, "_warnings", []),
            "memory": self.memory_snapshot(),
        }

    # --- Cloning payload persistence -----------------------------------
    # Default implementation pickles the payload after moving torch tensors
    # to CPU, so the file is portable between sessions and devices.

    def serialize_payload(self, payload: Any) -> bytes:
        import pickle
        return pickle.dumps(self._move_tensors(payload, "cpu"))

    def deserialize_payload(self, data: bytes, device: str) -> Any:
        import pickle
        payload = pickle.loads(data)
        return self._move_tensors(payload, device)

    def move_payload_to_device(self, payload: Any, device: str) -> Any:
        return self._move_tensors(payload, device)

    @classmethod
    def _move_tensors(cls, obj: Any, device: str) -> Any:
        """Recursively move torch.Tensor leaves of `obj` to `device`."""
        try:
            import torch
        except Exception:  # noqa: BLE001
            return obj
        if isinstance(obj, torch.Tensor):
            return obj.to(device)
        if isinstance(obj, list):
            return [cls._move_tensors(x, device) for x in obj]
        if isinstance(obj, tuple):
            return tuple(cls._move_tensors(x, device) for x in obj)
        if isinstance(obj, dict):
            return {k: cls._move_tensors(v, device) for k, v in obj.items()}
        if hasattr(obj, "__dataclass_fields__"):
            from dataclasses import replace
            return replace(
                obj,
                **{
                    f: cls._move_tensors(getattr(obj, f), device)
                    for f in obj.__dataclass_fields__
                },
            )
        return obj

    @abstractmethod
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
        """Return (samples_float32_in_-1..1, sample_rate)."""
        ...

    # --- Helpers shared across adapters ---------------------------------
    @staticmethod
    def _resolve_torch_device(requested: str) -> str:
        import torch
        if requested == "cuda" and torch.cuda.is_available():
            return "cuda"
        if requested == "mps" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
