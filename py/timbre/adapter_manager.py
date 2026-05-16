"""Own the single loaded TTS adapter and serialize model operations."""
from __future__ import annotations

import contextlib
import threading
from contextlib import contextmanager
from typing import Any, Iterator

from timbre.adapters.base import TTSAdapter
from timbre.adapters.factory import make_adapter


class AdapterManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._adapter: TTSAdapter | None = None
        self._device: str | None = None

    @contextmanager
    def operation(self) -> Iterator[None]:
        with self._lock:
            yield

    def ensure_loaded(self, model_id: str, device: str) -> TTSAdapter:
        with self._lock:
            if (
                self._adapter is not None
                and self._adapter.model_id == model_id
                and self._device == device
            ):
                return self._adapter
            self._unload_current()
            adapter = make_adapter(model_id)
            adapter.load(device)
            self._adapter = adapter
            self._device = device
            return adapter

    def reload_on_cpu(
        self,
        model_id: str,
        adapter: TTSAdapter | None = None,
    ) -> TTSAdapter:
        with self._lock:
            if adapter is not None:
                with contextlib.suppress(Exception):
                    adapter.unload()
            self._adapter = None
            self._device = None
            return self.ensure_loaded(model_id, "cpu")

    def unload_model(self, model_id: str) -> None:
        with self._lock:
            if self._adapter is not None and self._adapter.model_id == model_id:
                self._unload_current()

    def unload_all(self) -> None:
        with self._lock:
            self._unload_current()

    def current_device(self) -> str | None:
        with self._lock:
            return self._device

    def _unload_current(self) -> None:
        if self._adapter is not None:
            with contextlib.suppress(Exception):
                self._adapter.unload()
        self._adapter = None
        self._device = None
