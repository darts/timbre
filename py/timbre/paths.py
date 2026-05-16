"""Resolve app-data paths. The Rust shell passes TIMBRE_DATA_DIR; otherwise
fall back to a per-user dir so the sidecar can be exercised standalone."""
from __future__ import annotations

import os
from pathlib import Path
from functools import cache


@cache
def data_dir() -> Path:
    env = os.environ.get("TIMBRE_DATA_DIR")
    if env:
        p = Path(env)
    elif os.name == "nt":
        p = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "timbre"
    else:
        p = Path.home() / "Library" / "Application Support" / "timbre"
    p.mkdir(parents=True, exist_ok=True)
    return p


@cache
def cache_dir() -> Path:
    env = os.environ.get("TIMBRE_CACHE_DIR")
    if env:
        p = Path(env)
    elif os.name == "nt":
        p = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "timbre"
    elif os.uname().sysname == "Darwin":
        p = Path.home() / "Library" / "Caches" / "timbre"
    else:
        base = os.environ.get("XDG_CACHE_HOME")
        p = (Path(base) if base else Path.home() / ".cache") / "timbre"
    p.mkdir(parents=True, exist_ok=True)
    return p


def models_dir() -> Path:
    p = data_dir() / "models"
    p.mkdir(parents=True, exist_ok=True)
    return p


def voices_dir() -> Path:
    p = data_dir() / "voices"
    p.mkdir(parents=True, exist_ok=True)
    return p


def clips_dir() -> Path:
    p = data_dir() / "clips"
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    return data_dir() / "db.sqlite"
