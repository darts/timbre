from __future__ import annotations

from timbre.adapters.base import TTSAdapter
from timbre.registry import get


def make_adapter(model_id: str) -> TTSAdapter:
    info = get(model_id)
    if info.adapter == "qwen3":
        from timbre.adapters.qwen3 import Qwen3Adapter
        return Qwen3Adapter(model_id)
    if info.adapter == "chatterbox":
        from timbre.adapters.chatterbox import ChatterboxAdapter
        return ChatterboxAdapter(model_id)
    # F5 / XTTS adapters are not part of the commercial-safe first batch;
    # raise a clear error so the UI can surface it.
    raise NotImplementedError(
        f"Adapter '{info.adapter}' is not yet implemented in this build."
    )
