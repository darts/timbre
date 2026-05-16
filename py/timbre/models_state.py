"""Per-model install status + on-demand weight downloads.

Two independent things gate "model is usable":
  1. Adapter Python deps are importable in the active venv (e.g. `qwen_tts`).
  2. HF weights are present in the local hub cache.

This module is the single place that decides those questions, so the UI and
the synth path agree."""
from __future__ import annotations

import importlib.util
import importlib
import fnmatch
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from timbre import paths
from timbre.registry import ModelInfo, all_models, get


# Probes used to decide whether an adapter's Python deps are importable. Most
# adapters only need a shallow spec check. Chatterbox needs a real import
# because the top-level package can exist while librosa/perth dependencies
# still fail during `chatterbox.tts*` import.
_ADAPTER_IMPORT_PROBES: dict[str, tuple[str, ...]] = {
    "qwen3": ("qwen_tts",),
    "f5": ("f5_tts",),
    "chatterbox": ("chatterbox.tts", "chatterbox.tts_turbo"),
    "xtts": ("TTS",),  # idiap coqui-tts package
}
_DEEP_IMPORT_ADAPTERS = {"qwen3", "chatterbox"}
_DOWNLOAD_LOCK = threading.RLock()
_DOWNLOAD_PROGRESS: dict[str, dict[str, Any]] = {}
_DOWNLOAD_PLANS: dict[str, "DownloadPlan"] = {}
_ACTIVE_DOWNLOAD_PHASES = {"resolving", "weights", "finalizing"}


@dataclass(frozen=True)
class DownloadPlanFile:
    path: str
    size: int | None
    blob_id: str | None


@dataclass(frozen=True)
class DownloadPlan:
    files: tuple[DownloadPlanFile, ...]
    expected_bytes: int
    total_known: bool
    source: str
    error: str | None = None

    @property
    def files_total(self) -> int:
        return len(self.files)


def _set_download_progress(payload: dict[str, Any]) -> None:
    model_id = payload.get("model_id")
    if not isinstance(model_id, str):
        return
    with _DOWNLOAD_LOCK:
        _DOWNLOAD_PROGRESS[model_id] = dict(payload)


def _begin_download(model_id: str) -> None:
    with _DOWNLOAD_LOCK:
        existing = _DOWNLOAD_PROGRESS.get(model_id)
        if existing and existing.get("phase") in _ACTIVE_DOWNLOAD_PHASES:
            raise RuntimeError(f"model download already in progress: {model_id}")
        _DOWNLOAD_PROGRESS[model_id] = {
            "model_id": model_id,
            "phase": "resolving",
            "message": "resolving model files",
            "bytes": 0,
            "total_bytes": 0,
            "expected_bytes": 0,
            "downloaded_bytes": 0,
            "installed_bytes": 0,
            "fraction": None,
            "bytes_per_second": None,
            "eta_seconds": None,
            "files_done": 0,
            "files_total": 0,
            "size_source": "unknown",
        }


def download_status(model_id: str | None = None) -> list[dict[str, Any]] | dict[str, Any] | None:
    with _DOWNLOAD_LOCK:
        if model_id is not None:
            payload = _DOWNLOAD_PROGRESS.get(model_id)
            return dict(payload) if payload is not None else None
        return [dict(v) for v in _DOWNLOAD_PROGRESS.values()]


def _hf_repo_dir(repo_id: str) -> Path:
    # We point HUGGINGFACE_HUB_CACHE at `models_dir` directly (see
    # `hfcache.py`), so HF skips its default `hub/` subdirectory and lays
    # snapshots straight under the cache root.
    safe = repo_id.replace("/", "--")
    return paths.models_dir() / f"models--{safe}"


def _hf_locks_dir(repo_id: str) -> Path:
    safe = repo_id.replace("/", "--")
    return paths.models_dir() / ".locks" / f"models--{safe}"


def _matches_allowed(path: str, allow_patterns: list[str] | str | None) -> bool:
    if allow_patterns is None:
        return True
    patterns = [allow_patterns] if isinstance(allow_patterns, str) else allow_patterns
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def _filter_repo_paths(paths_: list[str], allow_patterns: list[str] | str | None) -> list[str]:
    try:
        from huggingface_hub.utils import filter_repo_objects
        return list(filter_repo_objects(paths_, allow_patterns=allow_patterns))
    except Exception:  # noqa: BLE001
        return [p for p in paths_ if _matches_allowed(p, allow_patterns)]


def _filter_repo_siblings(
    siblings: list[Any],
    allow_patterns: list[str] | str | None,
) -> list[Any]:
    key = lambda s: getattr(s, "rfilename", "")
    try:
        from huggingface_hub.utils import filter_repo_objects
        return list(filter_repo_objects(siblings, allow_patterns=allow_patterns, key=key))
    except Exception:  # noqa: BLE001
        return [s for s in siblings if _matches_allowed(key(s), allow_patterns)]


def _sibling_lfs_value(sibling: Any, key: str) -> Any:
    lfs = getattr(sibling, "lfs", None)
    if isinstance(lfs, dict):
        return lfs.get(key)
    return getattr(lfs, key, None)


def _sibling_size(sibling: Any) -> int | None:
    value = getattr(sibling, "size", None)
    if value is None:
        value = _sibling_lfs_value(sibling, "size")
    return int(value) if isinstance(value, (int, float)) and value >= 0 else None


def _sibling_blob_id(sibling: Any) -> str | None:
    value = getattr(sibling, "blob_id", None)
    if not value:
        value = _sibling_lfs_value(sibling, "sha256") or _sibling_lfs_value(sibling, "oid")
    return str(value) if value else None


def _plan_from_siblings(info: ModelInfo, siblings: list[Any]) -> DownloadPlan:
    files: list[DownloadPlanFile] = []
    all_sizes_known = True
    for sibling in _filter_repo_siblings(siblings, info.hf_files):
        filename = getattr(sibling, "rfilename", None)
        if not filename:
            continue
        size = _sibling_size(sibling)
        if size is None:
            all_sizes_known = False
        files.append(
            DownloadPlanFile(
                path=str(filename),
                size=size,
                blob_id=_sibling_blob_id(sibling),
            )
        )
    expected = sum(f.size or 0 for f in files) if all_sizes_known else 0
    return DownloadPlan(
        files=tuple(files),
        expected_bytes=expected,
        total_known=all_sizes_known and bool(files),
        source="hf",
    )


def _fetch_download_plan(info: ModelInfo) -> DownloadPlan:
    from huggingface_hub import HfApi

    repo_info = HfApi().repo_info(info.hf_repo, files_metadata=True)
    siblings = list(getattr(repo_info, "siblings", None) or [])
    plan = _plan_from_siblings(info, siblings)
    with _DOWNLOAD_LOCK:
        _DOWNLOAD_PLANS[info.id] = plan
    return plan


def _latest_snapshot_dir(info: ModelInfo) -> Path | None:
    repo_dir = _hf_repo_dir(info.hf_repo)
    refs_main = repo_dir / "refs" / "main"
    if refs_main.exists():
        try:
            commit = refs_main.read_text().strip()
            snapshot = repo_dir / "snapshots" / commit
            if snapshot.exists():
                return snapshot
        except OSError:
            pass

    snapshots = repo_dir / "snapshots"
    if not snapshots.exists():
        return None
    candidates = [p for p in snapshots.iterdir() if p.is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _snapshot_stats(info: ModelInfo) -> tuple[int, int]:
    snapshot = _latest_snapshot_dir(info)
    if snapshot is None:
        return 0, 0

    names = [
        p.relative_to(snapshot).as_posix()
        for p in snapshot.rglob("*")
        if p.is_file()
    ]
    allowed = set(_filter_repo_paths(names, info.hf_files))
    total = 0
    files = 0
    for name in allowed:
        path = snapshot / name
        try:
            total += path.stat().st_size
            files += 1
        except OSError:
            continue
    return total, files


def _remove_cache_dir(target: Path) -> bool:
    if not target.exists():
        return False
    base = paths.models_dir().resolve()
    resolved = target.resolve()
    if not resolved.is_relative_to(base):
        raise RuntimeError(f"refusing to remove path outside model cache: {target}")
    shutil.rmtree(resolved)
    return True


def _probe_adapter_import(info: ModelInfo) -> tuple[bool, str | None]:
    probe = _ADAPTER_IMPORT_PROBES.get(info.adapter)
    if not probe:
        return False, f"no import probe for adapter '{info.adapter}'"
    # The sidecar is a long-running process; once we've asked for `qwen_tts`
    # before pip installed it, FileFinder caches "not found" and never
    # rescans. Clear that cache so a freshly-installed package is visible.
    importlib.invalidate_caches()
    for module_name in probe:
        try:
            if info.adapter in _DEEP_IMPORT_ADAPTERS:
                importlib.import_module(module_name)
            elif importlib.util.find_spec(module_name) is None:
                return False, f"missing module '{module_name}'"
        except Exception as e:  # noqa: BLE001
            return False, f"{module_name}: {type(e).__name__}: {e}"
    return True, None


def deps_installed(info: ModelInfo) -> bool:
    ok, _ = _probe_adapter_import(info)
    return ok


def weights_downloaded(info: ModelInfo) -> bool:
    with _DOWNLOAD_LOCK:
        plan = _DOWNLOAD_PLANS.get(info.id)
    if plan and plan.files_total:
        state = _file_state(info, plan)
        return state["files_done"] >= plan.files_total
    return _latest_snapshot_dir(info) is not None


def status(model_id: str) -> dict[str, Any]:
    info = get(model_id)
    deps_ok, deps_error = _probe_adapter_import(info)
    installed_bytes, installed_files = _snapshot_stats(info)
    with _DOWNLOAD_LOCK:
        plan = _DOWNLOAD_PLANS.get(model_id)
        progress = _DOWNLOAD_PROGRESS.get(model_id)
    expected_bytes = (
        int(progress.get("expected_bytes") or progress.get("total_bytes") or 0)
        if progress
        else 0
    )
    files_total = int(progress.get("files_total") or 0) if progress else 0
    size_source = str(progress.get("size_source") or "") if progress else ""
    if not expected_bytes and plan and plan.total_known:
        expected_bytes = plan.expected_bytes
        files_total = plan.files_total
        size_source = plan.source
    if not expected_bytes and installed_bytes:
        expected_bytes = installed_bytes
        size_source = "installed"
    if not size_source:
        size_source = "manifest"
    return {
        "model_id": model_id,
        "deps_installed": deps_ok,
        "deps_error": deps_error,
        "weights_downloaded": weights_downloaded(info),
        "weights_path": str(_hf_repo_dir(info.hf_repo)),
        "expected_bytes": expected_bytes,
        "downloaded_bytes": installed_bytes,
        "installed_bytes": installed_bytes,
        "files_done": installed_files,
        "files_total": files_total or installed_files,
        "size_source": size_source,
    }


def all_statuses() -> list[dict[str, Any]]:
    return [status(m.id) for m in all_models()]


def remove_weights(model_id: str) -> dict[str, Any]:
    info = get(model_id)
    with _DOWNLOAD_LOCK:
        existing = _DOWNLOAD_PROGRESS.get(model_id)
        if existing and existing.get("phase") in _ACTIVE_DOWNLOAD_PHASES:
            raise RuntimeError(f"cannot remove while download is in progress: {model_id}")

    repo_dir = _hf_repo_dir(info.hf_repo)
    removed_bytes = _bytes_in_dir(repo_dir)
    removed = _remove_cache_dir(repo_dir)
    _remove_cache_dir(_hf_locks_dir(info.hf_repo))
    with _DOWNLOAD_LOCK:
        _DOWNLOAD_PROGRESS.pop(model_id, None)
    return {
        "model_id": model_id,
        "removed": removed,
        "removed_bytes": removed_bytes if removed else 0,
        "status": status(model_id),
    }


def _bytes_in_dir(p: Path) -> int:
    if not p.exists():
        return 0
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def _file_state(info: ModelInfo, plan: DownloadPlan) -> dict[str, int]:
    repo_dir = _hf_repo_dir(info.hf_repo)
    snapshot = _latest_snapshot_dir(info)
    complete_bytes = 0
    partial_bytes = 0
    files_done = 0

    if not plan.files:
        installed_bytes, installed_files = _snapshot_stats(info)
        blobs_dir = repo_dir / "blobs"
        incomplete_bytes = sum(
            _safe_size(p)
            for p in blobs_dir.glob("*.incomplete")
            if p.is_file()
        ) if blobs_dir.exists() else 0
        return {
            "downloaded_bytes": installed_bytes + incomplete_bytes,
            "installed_bytes": installed_bytes,
            "files_done": installed_files,
            "files_total": installed_files,
        }

    for file in plan.files:
        complete = False
        complete_size = 0
        if file.blob_id:
            blob = repo_dir / "blobs" / file.blob_id
            blob_size = _safe_size(blob)
            if blob_size and (file.size is None or blob_size >= file.size):
                complete = True
                complete_size = file.size or blob_size

        if not complete and snapshot is not None:
            pointer = snapshot / file.path
            pointer_size = _safe_size(pointer)
            if pointer_size and (file.size is None or pointer_size >= file.size):
                complete = True
                complete_size = file.size or pointer_size

        if complete:
            complete_bytes += complete_size
            files_done += 1
            continue

        if file.blob_id:
            incomplete = repo_dir / "blobs" / f"{file.blob_id}.incomplete"
            partial_size = _safe_size(incomplete)
            if partial_size:
                partial_bytes += min(partial_size, file.size) if file.size else partial_size

    downloaded = complete_bytes + partial_bytes
    if plan.total_known:
        downloaded = min(downloaded, plan.expected_bytes)
    return {
        "downloaded_bytes": downloaded,
        "installed_bytes": complete_bytes,
        "files_done": files_done,
        "files_total": plan.files_total,
    }


def _safe_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _speed_and_eta(
    *,
    samples: list[tuple[float, int]],
    now: float,
    downloaded_bytes: int,
    expected_bytes: int,
) -> tuple[float | None, float | None]:
    samples.append((now, downloaded_bytes))
    cutoff = now - 15.0
    while len(samples) > 1 and samples[0][0] < cutoff:
        samples.pop(0)
    if len(samples) < 2:
        return None, None

    elapsed = max(0.001, samples[-1][0] - samples[0][0])
    delta = max(0, samples[-1][1] - samples[0][1])
    speed = delta / elapsed
    if speed <= 0:
        return None, None
    remaining = max(0, expected_bytes - downloaded_bytes)
    eta = remaining / speed if expected_bytes > 0 else None
    return speed, eta


def download_weights(
    model_id: str,
    notify: Callable[[str, dict | None], None],
) -> dict[str, Any]:
    """Download the model's HF snapshot, emitting progress notifications.

    `notify` is the JSON-RPC notification helper supplied by the streaming
    method dispatcher. We use filtered HF metadata for the denominator and
    poll the cache's completed/incomplete blob files for the numerator.
    """
    info = get(model_id)
    _begin_download(model_id)
    samples: list[tuple[float, int]] = []
    emit_lock = threading.Lock()
    stop = threading.Event()

    def emit(
        phase: str,
        message: str,
        plan: DownloadPlan,
        event: str,
        *,
        error: str | None = None,
    ) -> dict[str, Any]:
        with emit_lock:
            now = time.time()
            state = _file_state(info, plan)
            expected = plan.expected_bytes if plan.total_known else 0
            downloaded = int(state["downloaded_bytes"])
            speed, eta = _speed_and_eta(
                samples=samples,
                now=now,
                downloaded_bytes=downloaded,
                expected_bytes=expected,
            )
            payload: dict[str, Any] = {
                "model_id": model_id,
                "phase": phase,
                "message": message,
                "bytes": downloaded,
                "total_bytes": expected,
                "expected_bytes": expected,
                "downloaded_bytes": downloaded,
                "installed_bytes": int(state["installed_bytes"]),
                "fraction": (
                    max(0.0, min(1.0, downloaded / expected))
                    if expected
                    else None
                ),
                "bytes_per_second": speed,
                "eta_seconds": eta,
                "files_done": int(state["files_done"]),
                "files_total": (
                    plan.files_total
                    if plan.files_total
                    else int(state["files_total"])
                ),
                "size_source": plan.source,
            }
            if error:
                payload["error"] = error
            _set_download_progress(payload)
            notify(event, payload)
            return payload

    resolving = {
        "model_id": model_id,
        "phase": "resolving",
        "message": "resolving model files",
        "bytes": 0,
        "total_bytes": 0,
        "expected_bytes": 0,
        "downloaded_bytes": 0,
        "installed_bytes": 0,
        "fraction": None,
        "bytes_per_second": None,
        "eta_seconds": None,
        "files_done": 0,
        "files_total": 0,
        "size_source": "unknown",
    }
    _set_download_progress(resolving)
    notify("models.download.started", resolving)

    try:
        plan = _fetch_download_plan(info)
    except Exception as e:  # noqa: BLE001
        installed_bytes, _ = _snapshot_stats(info)
        plan = DownloadPlan(
            (),
            installed_bytes,
            bool(installed_bytes),
            "installed" if installed_bytes else "manifest",
            f"{type(e).__name__}: {e}",
        )

    emit("weights", "downloading weights", plan, "models.download.progress")

    def poller() -> None:
        last_bytes = -1
        last_emit = 0.0
        while not stop.is_set():
            current = int(_file_state(info, plan)["downloaded_bytes"])
            now = time.time()
            if current != last_bytes or now - last_emit >= 2.0:
                last_bytes = current
                last_emit = now
                emit("weights", "downloading weights", plan, "models.download.progress")
            stop.wait(0.5)

    thread = threading.Thread(target=poller, daemon=True)
    thread.start()
    try:
        from huggingface_hub import snapshot_download
        # Bytes finish well before snapshot_download returns — the tail of
        # the call is spent materialising symlinks in `snapshots/<rev>/`.
        # Tell the UI we're in that phase so 100% doesn't look stalled.
        def _finalise_notify() -> None:
            # Wait until bytes plateau, then announce finalisation. This
            # runs in a separate thread so it doesn't block the download.
            last = -1
            stable_ticks = 0
            while not stop.is_set():
                cur = int(_file_state(info, plan)["downloaded_bytes"])
                if plan.total_known and cur >= plan.expected_bytes and cur == last:
                    stable_ticks += 1
                    if stable_ticks >= 2:
                        emit(
                            "finalizing",
                            "finalising — linking files into the cache",
                            plan,
                            "models.download.finalizing",
                        )
                        return
                else:
                    stable_ticks = 0
                last = cur
                stop.wait(0.5)

        finaliser = threading.Thread(target=_finalise_notify, daemon=True)
        finaliser.start()

        snapshot_download(
            repo_id=info.hf_repo,
            cache_dir=str(paths.models_dir()),
            allow_patterns=info.hf_files,  # None means everything
        )
    except Exception as e:  # noqa: BLE001
        emit(
            "error",
            "download failed",
            plan,
            "models.download.error",
            error=f"{type(e).__name__}: {e}",
        )
        raise
    finally:
        stop.set()
        thread.join(timeout=2)

    final = emit("ready", "ready", plan, "models.download.complete")
    if plan.total_known:
        final["fraction"] = 1.0
        _set_download_progress(final)
    # Small grace period so the UI sees the completed snapshot before it
    # asks for status.
    time.sleep(0.05)
    return status(model_id)
