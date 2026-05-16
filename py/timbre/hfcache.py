"""Point HuggingFace caching at our app-data models/ directory before any
huggingface_hub or transformers import runs."""
from __future__ import annotations

import os

from timbre.paths import cache_dir, models_dir


def configure() -> None:
    target = str(models_dir())
    numba_cache = cache_dir() / "numba"
    numba_cache.mkdir(parents=True, exist_ok=True)
    # HF_HOME alone covers the modern transformers + huggingface_hub stack;
    # HUGGINGFACE_HUB_CACHE keeps cache on the same root without HF's
    # default `hub/` subdirectory. TRANSFORMERS_CACHE is deprecated and
    # emits a FutureWarning, so we leave it unset.
    os.environ.setdefault("HF_HOME", target)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", target)
    # Chatterbox imports Perth -> librosa -> numba. In the bundled Python
    # venv, numba can fail with "no locator available" unless it has an
    # explicit writable cache directory.
    os.environ.setdefault("NUMBA_CACHE_DIR", str(numba_cache))
