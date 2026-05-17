"""Loads the bundled models manifest and exposes lookups."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any


@dataclass
class ModelInfo:
    id: str
    name: str
    vendor: str
    license: str
    license_url: str
    license_acknowledgement_required: bool
    adapter: str
    hf_repo: str
    hf_files: list[str] | None
    approx_size_mb: int
    sample_rate: int
    ref_clip: dict[str, Any]
    languages: list[str]
    hardware: list[str]
    is_default: bool = False
    raw: dict[str, Any] | None = None


def _manifest_path() -> Path:
    env = os.environ.get("TIMBRE_MANIFEST")
    if env:
        return Path(env)
    # Walk up from this file to find resources/models.manifest.json.
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "resources" / "models.manifest.json"
        if candidate.exists():
            return candidate
    raise FileNotFoundError("models.manifest.json not found; set TIMBRE_MANIFEST")


@cache
def all_models() -> list[ModelInfo]:
    data = json.loads(_manifest_path().read_text(encoding="utf-8"))
    out = []
    for m in data["models"]:
        out.append(
            ModelInfo(
                id=m["id"],
                name=m["name"],
                vendor=m["vendor"],
                license=m["license"],
                license_url=m["license_url"],
                license_acknowledgement_required=m.get("license_acknowledgement_required", False),
                adapter=m["adapter"],
                hf_repo=m["hf_repo"],
                hf_files=m.get("hf_files"),
                approx_size_mb=m["approx_size_mb"],
                sample_rate=m["sample_rate"],
                ref_clip=m["ref_clip"],
                languages=m["languages"],
                hardware=m["hardware"],
                is_default=m.get("is_default", False),
                raw=m,
            )
        )
    return out


def get(model_id: str) -> ModelInfo:
    for m in all_models():
        if m.id == model_id:
            return m
    raise KeyError(f"unknown model: {model_id}")
