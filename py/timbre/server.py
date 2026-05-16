"""Sidecar entry point. Listens on stdio for JSON-RPC requests from the
Rust shell, dispatches to handlers, and pushes progress notifications back
on the same channel.

All paths exchanged with the shell are absolute filesystem paths."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from timbre import hfcache
from timbre.audio import concat_with_crossfade, write_wav
from timbre.chunking import chunk_text
from timbre.paths import clips_dir
from timbre.registry import all_models, get
from timbre.rpc import RpcError, RpcServer, ERR_INVALID_PARAMS
from timbre import voicelib
from timbre.adapters.base import TTSAdapter
from timbre.adapter_manager import AdapterManager
from timbre.device_policy import (
    accelerator_retry_reason,
    best_available_device,
    device_label,
    log_cpu_handoff,
)

# Configure HF cache before any model-import code touches the env.
hfcache.configure()
voicelib.init_db()


_ADAPTERS = AdapterManager()
_PROGRESS_LOCK = threading.RLock()
_SYNTH_PROGRESS: dict[str, dict[str, Any]] = {}
_ACTIVE_SYNTHESIS_ID: str | None = None
_SYNTH_RUN_LOCK = threading.Lock()
_RUNNING_SYNTHESIS_ID: str | None = None
_SYNTH_STARTING = "pending"
_TERMINAL_SYNTH_PHASES = {"complete", "failed"}
_VOICE_PROMPT_ARCHIVE_FORMAT = "timbre.voice_prompts"
_VOICE_PROMPT_ARCHIVE_VERSION = 1
_LEGACY_LANGUAGE_CODE_TO_NAME = {
    "zh": "chinese",
    "en": "english",
    "fr": "french",
    "de": "german",
    "it": "italian",
    "ja": "japanese",
    "ko": "korean",
    "pt": "portuguese",
    "ru": "russian",
    "es": "spanish",
}


def _begin_synthesis_run() -> None:
    global _RUNNING_SYNTHESIS_ID
    with _SYNTH_RUN_LOCK:
        if _RUNNING_SYNTHESIS_ID is not None:
            active = (
                "starting"
                if _RUNNING_SYNTHESIS_ID == _SYNTH_STARTING
                else _RUNNING_SYNTHESIS_ID
            )
            raise RpcError(
                ERR_INVALID_PARAMS,
                f"synthesis already in progress: {active}",
            )
        _RUNNING_SYNTHESIS_ID = _SYNTH_STARTING


def _activate_synthesis_run(synthesis_id: str) -> None:
    global _RUNNING_SYNTHESIS_ID
    with _SYNTH_RUN_LOCK:
        _RUNNING_SYNTHESIS_ID = synthesis_id
    _set_active_synthesis(synthesis_id)


def _finish_synthesis_run(synthesis_id: str | None = None) -> None:
    global _RUNNING_SYNTHESIS_ID
    with _SYNTH_RUN_LOCK:
        if (
            synthesis_id is None
            or _RUNNING_SYNTHESIS_ID in (synthesis_id, _SYNTH_STARTING)
        ):
            _RUNNING_SYNTHESIS_ID = None


def _running_synthesis_id() -> str | None:
    with _SYNTH_RUN_LOCK:
        return _RUNNING_SYNTHESIS_ID


def _set_active_synthesis(synthesis_id: str) -> None:
    global _ACTIVE_SYNTHESIS_ID
    with _PROGRESS_LOCK:
        _ACTIVE_SYNTHESIS_ID = synthesis_id


def _store_synth_progress(payload: dict[str, Any]) -> None:
    synthesis_id = payload.get("synthesis_id")
    if not isinstance(synthesis_id, str):
        return
    with _PROGRESS_LOCK:
        _SYNTH_PROGRESS[synthesis_id] = dict(payload)
    if payload.get("phase") in _TERMINAL_SYNTH_PHASES:
        _finish_synthesis_run(synthesis_id)


def _latest_synth_progress(synthesis_id: str | None = None) -> dict[str, Any] | None:
    with _PROGRESS_LOCK:
        sid = synthesis_id or _ACTIVE_SYNTHESIS_ID
        if sid is None:
            return None
        payload = _SYNTH_PROGRESS.get(sid)
        return dict(payload) if payload is not None else None


def _model_name(model_id: str) -> str:
    try:
        return get(model_id).name
    except Exception:  # noqa: BLE001
        return model_id


def _model_deleted(model_id: str) -> bool:
    try:
        info = get(model_id)
    except Exception:  # noqa: BLE001
        return True
    try:
        from timbre import models_state

        return not models_state.weights_downloaded(info)
    except Exception:  # noqa: BLE001
        return True


def _chunking_options(info: Any) -> dict[str, int]:
    raw = getattr(info, "raw", None) or {}
    cfg = raw.get("chunking") if isinstance(raw, dict) else None
    if not isinstance(cfg, dict):
        return {}
    out: dict[str, int] = {}
    for key in ("target_chars", "max_chars"):
        value = cfg.get(key)
        if isinstance(value, (int, float)) and value > 0:
            out[key] = int(value)
    return out


def _validate_synth_params(info: Any, params: dict[str, Any]) -> dict[str, Any]:
    out = dict(params)
    raw_language = out.get("language")
    if raw_language is None or raw_language == "":
        out.pop("language", None)
        return out
    if not isinstance(raw_language, str):
        raise RpcError(ERR_INVALID_PARAMS, "language must be a string")
    requested_language = raw_language.strip().lower()
    if not requested_language:
        out.pop("language", None)
        return out
    language = _LEGACY_LANGUAGE_CODE_TO_NAME.get(requested_language, requested_language)
    supported = [str(code).lower() for code in getattr(info, "languages", [])]
    if language not in supported:
        supported_text = ", ".join(supported) or "none"
        raise RpcError(
            ERR_INVALID_PARAMS,
            f"{info.name} does not support language '{raw_language}'. "
            f"Supported languages: {supported_text}",
        )
    out["language"] = language
    return out


def _history_item(row: dict[str, Any]) -> dict[str, Any]:
    raw_params = row.get("params_json")
    parsed_params: dict[str, Any] = {}
    if raw_params:
        try:
            decoded = json.loads(raw_params)
            if isinstance(decoded, dict):
                parsed_params = decoded
        except (TypeError, ValueError):
            parsed_params = {}
    return {
        "id": row["id"],
        "voice_id": row["voice_id"],
        "voice_name": row.get("voice_name") or row.get("voice_name_snapshot") or row["voice_id"],
        "voice_version": row.get("voice_version") or row.get("voice_version_snapshot") or 1,
        "model_id": row["model_id"],
        "model_name": row.get("model_name") or row.get("model_name_snapshot") or _model_name(row["model_id"]),
        "voice_deleted": bool(row.get("voice_deleted")),
        "model_deleted": _model_deleted(row["model_id"]),
        "full_text": row["full_text"],
        "requested_device": row.get("requested_device") or "cpu",
        "resolved_device": row.get("resolved_device"),
        "device_detail": row.get("device_detail"),
        "fallback_device": row.get("fallback_device"),
        "fallback_reason": row.get("fallback_reason"),
        "created_at": row["created_at"],
        "updated_at": row.get("updated_at") or row["created_at"],
        "final_audio_path": row.get("final_audio_path"),
        "duration_ms": row.get("duration_ms"),
        "status": row.get("status") or "pending",
        "params": parsed_params,
        "batch_id": row.get("batch_id"),
        "batch_index": row.get("batch_index"),
        "batch_count": row.get("batch_count"),
        "is_favorite": bool(row.get("is_favorite")),
    }


def _rebuild_final_audio(synthesis_id: str) -> dict[str, Any]:
    """Concatenate ready chunk WAVs into the synthesis-level playable WAV."""
    chunks = voicelib.list_chunks(synthesis_id)
    audio_paths = [
        Path(c["audio_path"])
        for c in chunks
        if c.get("audio_path") and c.get("status") == "ready"
    ]
    if not audio_paths:
        raise RuntimeError("cannot build final audio without ready chunks")
    samples, sr = concat_with_crossfade(audio_paths)
    final_path = clips_dir() / synthesis_id / "full.wav"
    write_wav(final_path, samples, sr)
    duration_ms = int(len(samples) * 1000 / sr)
    voicelib.update_synthesis_result(
        synthesis_id,
        final_audio_path=str(final_path),
        duration_ms=duration_ms,
    )
    return {
        "final_audio_path": str(final_path),
        "duration_ms": duration_ms,
    }


def _adapter_diagnostics(adapter: TTSAdapter | None) -> dict[str, Any]:
    if adapter is None:
        return {}
    try:
        return adapter.diagnostics()
    except Exception:  # noqa: BLE001
        return {}


def _prepare_voice_reference(source_path: str, voice_id: str) -> tuple[str, int, int]:
    """Copy a user-provided reference clip into app-managed voice storage."""
    from timbre.audio import prepare_reference_wav
    from timbre.paths import data_dir, voices_dir

    source = Path(source_path).expanduser()
    if not source.exists():
        raise RpcError(ERR_INVALID_PARAMS, f"reference audio does not exist: {source}")

    out_dir = voices_dir() / voice_id
    out_path = out_dir / "reference.wav"
    try:
        sr, duration_ms = prepare_reference_wav(source, out_path)
    except RpcError:
        raise
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(out_dir, ignore_errors=True)
        raise RpcError(ERR_INVALID_PARAMS, f"reference audio is not usable: {e}") from e

    # Browser microphone captures land in data_dir/recordings first because
    # the frontend does not know the final voice id yet. Once imported, that
    # staging file is no longer needed. Never delete arbitrary user files.
    with contextlib.suppress(Exception):
        source_resolved = source.resolve()
        recordings_dir = (data_dir() / "recordings").resolve()
        if source_resolved.is_relative_to(recordings_dir):
            source_resolved.unlink(missing_ok=True)

    return str(out_path), sr, duration_ms


def _prompt_archive_member_is_safe(member: str) -> bool:
    path = PurePosixPath(member)
    return (
        bool(member)
        and not path.is_absolute()
        and len(path.parts) >= 2
        and path.parts[0] == "prompts"
        and all(part not in ("", ".", "..") for part in path.parts)
    )


def _prompt_archive_name(model_id: str) -> str:
    safe = "".join(
        ch if ch.isalnum() or ch in ("-", "_", ".") else "_"
        for ch in model_id
    )
    return f"prompts/{safe}.pkl"


def _safe_export_destination(destination_path: str) -> Path:
    destination = Path(destination_path).expanduser()
    if destination.suffix == "":
        destination = destination.with_suffix(".timbrevoice")
    if destination.parent:
        destination.parent.mkdir(parents=True, exist_ok=True)
    return destination


def build_server() -> RpcServer:
    rpc = RpcServer()

    # --- Discovery ---------------------------------------------------------
    @rpc.method("ping")
    def ping() -> dict:
        return {"ok": True, "pid": os.getpid()}

    @rpc.method("list_models")
    def list_models() -> list[dict]:
        return [m.raw or {} for m in all_models()]

    # --- Models ------------------------------------------------------------
    @rpc.method("models.list_status")
    def models_list_status() -> list[dict]:
        from timbre import models_state
        return models_state.all_statuses()

    @rpc.method("models.status")
    def models_status(model_id: str) -> dict:
        from timbre import models_state
        return models_state.status(model_id)

    @rpc.method("models.download_status")
    def models_download_status(model_id: str | None = None) -> dict | list[dict] | None:
        from timbre import models_state
        return models_state.download_status(model_id)

    @rpc.method("models.download_weights", streaming=True)
    def models_download_weights(notify: Callable[..., None], model_id: str) -> dict:
        from timbre import models_state
        return models_state.download_weights(model_id, notify)

    @rpc.method("models.remove_weights")
    def models_remove_weights(model_id: str) -> dict:
        if _running_synthesis_id() is not None:
            raise RpcError(ERR_INVALID_PARAMS, "cannot remove model weights while synthesis is running")
        _ADAPTERS.unload_model(model_id)
        from timbre import models_state
        return models_state.remove_weights(model_id)

    # --- Transcription -----------------------------------------------------
    @rpc.method("transcribe.is_available")
    def transcribe_is_available() -> dict:
        from timbre import transcribe as t
        return {"available": t.is_available()}

    @rpc.method("transcribe.audio")
    def transcribe_audio(audio_path: str, language: str | None = None) -> dict:
        from timbre import transcribe as t
        return t.transcribe(audio_path, language=language)

    @rpc.method("device_capabilities")
    def device_capabilities() -> dict:
        try:
            import torch
            return {
                "torch_version": torch.__version__,
                "cuda": bool(torch.cuda.is_available()),
                "mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
                "cpu": True,
            }
        except Exception as e:  # noqa: BLE001
            return {"error": f"torch not available: {e}", "cpu": True, "cuda": False, "mps": False}

    # --- Voices ------------------------------------------------------------
    @rpc.method("voices.list")
    def voices_list() -> list[dict]:
        return voicelib.list_voices()

    @rpc.method("voices.create")
    def voices_create(
        name: str,
        ref_audio_path: str,
        ref_transcript: str | None = None,
        source_notes: str | None = None,
    ) -> dict:
        voice_id = str(uuid.uuid4())
        try:
            managed_path, sr, duration_ms = _prepare_voice_reference(ref_audio_path, voice_id)
            return voicelib.create_voice(
                voice_id=voice_id,
                name=name,
                ref_audio_path=managed_path,
                ref_audio_sr=sr,
                ref_duration_ms=duration_ms,
                ref_transcript=ref_transcript,
                source_notes=source_notes,
            )
        except Exception:
            from timbre.paths import voices_dir
            shutil.rmtree(voices_dir() / voice_id, ignore_errors=True)
            raise

    @rpc.method("voices.update")
    def voices_update(
        voice_id: str,
        name: str,
        ref_audio_path: str | None = None,
        ref_transcript: str | None = None,
        source_notes: str | None = None,
    ) -> dict:
        old = voicelib.get_voice(voice_id)
        if old.get("prompt_only"):
            raise RpcError(ERR_INVALID_PARAMS, "prompt-only imported voices cannot be edited")
        audio_path = ref_audio_path or old["ref_audio_path"]
        new_voice_id = str(uuid.uuid4())
        try:
            managed_path, sr, duration_ms = _prepare_voice_reference(audio_path, new_voice_id)
            return voicelib.create_voice_version(
                voice_id,
                new_voice_id=new_voice_id,
                name=name,
                ref_audio_path=managed_path,
                ref_audio_sr=sr,
                ref_duration_ms=duration_ms,
                ref_transcript=ref_transcript,
                source_notes=source_notes,
            )
        except Exception:
            from timbre.paths import voices_dir
            shutil.rmtree(voices_dir() / new_voice_id, ignore_errors=True)
            raise

    @rpc.method("voices.delete")
    def voices_delete(voice_id: str) -> dict:
        # Hide the full voice family while keeping synthesis history rows
        # playable. Prompt artefacts can be dropped because history stores
        # generated audio separately under clips/.
        deleted_ids = voicelib.delete_voice(voice_id)
        from timbre.paths import voices_dir
        import shutil
        for vid in deleted_ids:
            target = voices_dir() / vid
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
        return {"ok": True}

    @rpc.method("voices.export_prompts")
    def voices_export_prompts(voice_id: str, destination_path: str) -> dict:
        voice = voicelib.get_voice(voice_id)
        prompt_rows = []
        for row in voicelib.list_embeddings(voice_id):
            path = Path(row["payload_path"])
            if path.exists() and path.is_file():
                prompt_rows.append((row, path))
        if not prompt_rows:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "this voice has no cached prompts to export; prepare it for a model first",
            )

        manifest_prompts: list[dict[str, Any]] = []
        payloads: list[tuple[str, bytes]] = []
        used_members: set[str] = set()
        for row, path in prompt_rows:
            data = path.read_bytes()
            member = _prompt_archive_name(row["model_id"])
            if member in used_members:
                member = f"prompts/{uuid.uuid4().hex}.pkl"
            used_members.add(member)
            payloads.append((member, data))
            manifest_prompts.append({
                "model_id": row["model_id"],
                "model_name": _model_name(row["model_id"]),
                "path": member,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "schema_version": int(row.get("schema_version") or 1),
                "created_at": row.get("created_at"),
            })

        manifest = {
            "format": _VOICE_PROMPT_ARCHIVE_FORMAT,
            "version": _VOICE_PROMPT_ARCHIVE_VERSION,
            "exported_at": int(time.time() * 1000),
            "voice": {
                "name": voice.get("name") or "Imported voice",
                "version": voice.get("version") or 1,
            },
            "prompts": manifest_prompts,
        }
        destination = _safe_export_destination(destination_path)
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
            for member, data in payloads:
                zf.writestr(member, data)
        return {
            "voice_id": voice_id,
            "path": str(destination),
            "prompt_count": len(payloads),
            "model_ids": [p["model_id"] for p in manifest_prompts],
        }

    @rpc.method("voices.import_prompts")
    def voices_import_prompts(archive_path: str) -> dict:
        source = Path(archive_path).expanduser()
        if not source.exists() or not source.is_file():
            raise RpcError(ERR_INVALID_PARAMS, f"voice archive does not exist: {source}")

        known_model_ids = {m.id for m in all_models()}
        try:
            with zipfile.ZipFile(source, "r") as zf:
                try:
                    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
                except KeyError as e:
                    raise RpcError(ERR_INVALID_PARAMS, "voice archive is missing manifest.json") from e
                if (
                    not isinstance(manifest, dict)
                    or manifest.get("format") != _VOICE_PROMPT_ARCHIVE_FORMAT
                    or manifest.get("version") != _VOICE_PROMPT_ARCHIVE_VERSION
                ):
                    raise RpcError(ERR_INVALID_PARAMS, "unsupported voice archive format")
                prompts = manifest.get("prompts")
                if not isinstance(prompts, list) or not prompts:
                    raise RpcError(ERR_INVALID_PARAMS, "voice archive contains no prompts")

                voice_meta = manifest.get("voice") if isinstance(manifest.get("voice"), dict) else {}
                name = str(voice_meta.get("name") or "Imported voice").strip() or "Imported voice"
                prompt_payloads: list[tuple[str, bytes]] = []
                skipped: list[str] = []
                for entry in prompts:
                    if not isinstance(entry, dict):
                        continue
                    model_id = entry.get("model_id")
                    member = entry.get("path")
                    expected_sha = entry.get("sha256")
                    if not isinstance(model_id, str) or not model_id:
                        continue
                    if model_id not in known_model_ids:
                        skipped.append(model_id)
                        continue
                    if not isinstance(member, str) or not _prompt_archive_member_is_safe(member):
                        raise RpcError(ERR_INVALID_PARAMS, f"unsafe prompt path in archive: {member}")
                    if not isinstance(expected_sha, str) or len(expected_sha) != 64:
                        raise RpcError(ERR_INVALID_PARAMS, f"missing checksum for {model_id}")
                    try:
                        data = zf.read(member)
                    except KeyError as e:
                        raise RpcError(ERR_INVALID_PARAMS, f"archive is missing prompt payload for {model_id}") from e
                    actual_sha = hashlib.sha256(data).hexdigest()
                    if actual_sha != expected_sha:
                        raise RpcError(ERR_INVALID_PARAMS, f"checksum mismatch for {model_id}")
                    prompt_payloads.append((model_id, data))
        except zipfile.BadZipFile as e:
            raise RpcError(ERR_INVALID_PARAMS, "voice archive is not a valid zip file") from e

        if not prompt_payloads:
            raise RpcError(ERR_INVALID_PARAMS, "voice archive has no prompts for known app models")

        voice_id = str(uuid.uuid4())
        try:
            voice = voicelib.create_prompt_only_voice(name=name, voice_id=voice_id)
            from timbre.paths import voices_dir
            out_dir = voices_dir() / voice_id / "embeddings"
            out_dir.mkdir(parents=True, exist_ok=True)
            for model_id, data in prompt_payloads:
                out_path = out_dir / f"{model_id}.pkl"
                out_path.write_bytes(data)
                voicelib.set_embedding(voice_id, model_id, out_path)
            voice = voicelib.get_voice(voice_id)
        except Exception:
            from timbre.paths import voices_dir
            try:
                voicelib.hard_delete_voice(voice_id)
            except Exception:  # noqa: BLE001
                pass
            shutil.rmtree(voices_dir() / voice_id, ignore_errors=True)
            raise

        return {
            **voice,
            "imported_prompts": [model_id for model_id, _ in prompt_payloads],
            "skipped_prompts": skipped,
        }

    @rpc.method("voices.prompt_status")
    def voices_prompt_status(voice_id: str, model_id: str) -> dict:
        """Whether a cached voice-clone prompt exists for this (voice, model)."""
        path = voicelib.get_embedding_path(voice_id, model_id)
        return {
            "voice_id": voice_id,
            "model_id": model_id,
            "ready": path is not None and path.exists(),
            "path": str(path) if path else None,
        }

    @rpc.method("voices.prompt_status_all")
    def voices_prompt_status_all(model_id: str) -> list[dict]:
        """One-shot version of `voices.prompt_status` over every known voice."""
        out = []
        for v in voicelib.list_voices():
            path = voicelib.get_embedding_path(v["id"], model_id)
            out.append({
                "voice_id": v["id"],
                "model_id": model_id,
                "ready": path is not None and path.exists(),
                "path": str(path) if path else None,
            })
        return out

    @rpc.method("voices.prepare_for_model", streaming=True)
    def voices_prepare_for_model(
        notify: Callable[..., None],
        voice_id: str,
        model_id: str,
        device: str | None = None,
        force: bool = False,
    ) -> dict:
        if _running_synthesis_id() is not None:
            raise RpcError(ERR_INVALID_PARAMS, "cannot prepare voices while synthesis is running")
        if device is None:
            device = best_available_device()
        existing = voicelib.get_embedding_path(voice_id, model_id)
        if existing and existing.exists() and not force:
            return {"voice_id": voice_id, "model_id": model_id, "cached": True,
                    "reused": True, "path": str(existing)}

        voice = voicelib.get_voice(voice_id)
        if voice.get("prompt_only"):
            raise RpcError(ERR_INVALID_PARAMS, "prompt-only imported voices cannot be prepared without source audio")
        ref_path = Path(voice["ref_audio_path"])
        ref_transcript = voice.get("ref_transcript")
        notify("voice.prepare.loading_model", {
            "voice_id": voice_id, "model_id": model_id,
        })
        with _ADAPTERS.operation():
            try:
                adapter = _ADAPTERS.ensure_loaded(model_id, device)
            except Exception as e:
                reason = accelerator_retry_reason(e, device, None)
                if reason is None:
                    raise
                label = device_label(device)
                notify("voice.prepare.warning", {
                    "voice_id": voice_id,
                    "model_id": model_id,
                    "warning": f"{label} failed while loading model; retrying on CPU: {reason}",
                })
                log_cpu_handoff(
                    context="voice.prepare.load_model",
                    model_id=model_id,
                    requested_device=device,
                    reason=reason,
                )
                adapter = _ADAPTERS.reload_on_cpu(model_id)
            notify("voice.prepare.encoding", {
                "voice_id": voice_id, "model_id": model_id,
            })
            try:
                clone_result = adapter.clone(ref_path, ref_transcript)
            except Exception as e:
                reason = accelerator_retry_reason(e, device, adapter)
                if reason is None:
                    raise
                label = device_label(device)
                notify("voice.prepare.warning", {
                    "voice_id": voice_id,
                    "model_id": model_id,
                    "warning": f"{label} failed while encoding prompt; retrying on CPU: {reason}",
                })
                log_cpu_handoff(
                    context="voice.prepare.encode_prompt",
                    model_id=model_id,
                    requested_device=device,
                    reason=reason,
                )
                adapter = _ADAPTERS.reload_on_cpu(model_id, adapter)
                clone_result = adapter.clone(ref_path, ref_transcript)
        if clone_result is None or clone_result.payload is None:
            return {"voice_id": voice_id, "model_id": model_id, "cached": False,
                    "reason": "adapter does not produce a persistable payload"}

        from timbre.paths import voices_dir
        out_dir = voices_dir() / voice_id / "embeddings"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{model_id}.pkl"
        out_path.write_bytes(adapter.serialize_payload(clone_result.payload))
        voicelib.set_embedding(voice_id, model_id, out_path)
        notify("voice.prepare.complete", {
            "voice_id": voice_id, "model_id": model_id, "path": str(out_path),
        })
        return {"voice_id": voice_id, "model_id": model_id, "cached": True,
                "reused": False, "path": str(out_path)}

    # --- Synthesis ---------------------------------------------------------
    @rpc.method("synth.list_history")
    def synth_list_history(limit: int = 50) -> list[dict]:
        return [_history_item(s) for s in voicelib.list_syntheses(limit)]

    @rpc.method("synth.get")
    def synth_get(synthesis_id: str) -> dict:
        row = voicelib.get_synthesis(synthesis_id)
        item = _history_item(row)
        item["chunks"] = voicelib.list_chunks(synthesis_id)
        return item

    @rpc.method("synth.set_favorite")
    def synth_set_favorite(synthesis_id: str) -> dict:
        voicelib.set_synthesis_favorite(synthesis_id)
        return {"ok": True}

    @rpc.method("synth.progress_latest")
    def synth_progress_latest(synthesis_id: str | None = None) -> dict | None:
        return _latest_synth_progress(synthesis_id)

    @rpc.method("synth.running")
    def synth_running() -> dict:
        running_id = _running_synthesis_id()
        synthesis_id = None if running_id == _SYNTH_STARTING else running_id
        return {
            "running": running_id is not None,
            "synthesis_id": synthesis_id,
            "progress": _latest_synth_progress(synthesis_id),
        }

    @rpc.method("synth.run", streaming=True)
    def synth_run(
        notify: Callable[..., None],
        voice_id: str,
        text: str,
        model_id: str,
        device: str = "cpu",
        seed: int | None = None,
        params: dict[str, Any] | None = None,
        batch_id: str | None = None,
        batch_index: int | None = None,
        batch_count: int | None = None,
    ) -> dict:
        if not text.strip():
            raise RpcError(ERR_INVALID_PARAMS, "text is empty")
        params = params or {}
        info = get(model_id)
        params = _validate_synth_params(info, params)
        voice = voicelib.get_voice(voice_id)
        prompt_only = bool(voice.get("prompt_only"))
        existing_prompt = voicelib.get_embedding_path(voice_id, model_id)
        ref_path = Path(voice["ref_audio_path"])
        ref_transcript = voice.get("ref_transcript")
        if prompt_only and not (existing_prompt and existing_prompt.exists()):
            raise RpcError(
                ERR_INVALID_PARAMS,
                f"prompt-only voice does not include a cached prompt for {info.name}",
            )
        if info.ref_clip.get("transcript_required") and not ref_transcript and not prompt_only:
            raise RpcError(ERR_INVALID_PARAMS, f"{info.name} requires a reference transcript")

        chunks = chunk_text(
            text,
            language=params.get("language", "en"),
            **_chunking_options(info),
        )
        persisted_params = dict(params)
        if seed is not None:
            persisted_params["seed"] = seed
        _begin_synthesis_run()
        try:
            synthesis_id = voicelib.create_synthesis(
                voice_id=voice_id,
                model_id=model_id,
                full_text=text,
                params=persisted_params,
                requested_device=device,
                voice_name_snapshot=voice.get("name"),
                voice_version_snapshot=int(voice.get("version") or 1),
                model_name_snapshot=info.name,
                batch_id=batch_id,
                batch_index=batch_index,
                batch_count=batch_count,
            )
        except Exception:
            _finish_synthesis_run()
            raise
        started_at = time.time()
        adapter: TTSAdapter | None = None
        cached_payload = None
        fallback_device: str | None = None
        fallback_reason: str | None = None

        def progress(
            phase: str,
            message: str,
            *,
            chunk_idx: int | None = None,
            fraction: float | None = None,
            extra: dict[str, Any] | None = None,
        ) -> None:
            diag = _adapter_diagnostics(adapter)
            payload: dict[str, Any] = {
                "synthesis_id": synthesis_id,
                "model_id": model_id,
                "requested_device": device,
                "resolved_device": diag.get("resolved_device"),
                "device_detail": diag.get("device_detail"),
                "fallback_device": fallback_device,
                "fallback_reason": fallback_reason,
                "warnings": diag.get("warnings") or [],
                "phase": phase,
                "message": message,
                "chunk_idx": chunk_idx,
                "chunk_count": len(chunks),
                "fraction": fraction,
                "elapsed_ms": int((time.time() - started_at) * 1000),
                "memory": diag.get("memory") or {},
            }
            if extra:
                extra_warnings = extra.get("warnings")
                payload.update({k: v for k, v in extra.items() if k != "warnings"})
                if extra_warnings:
                    if not isinstance(extra_warnings, list):
                        extra_warnings = [str(extra_warnings)]
                    payload["warnings"] = [
                        *payload["warnings"],
                        *extra_warnings,
                    ]
            _store_synth_progress(payload)
            notify("synth.progress", payload)

        def with_heartbeat(
            phase: str,
            message: str,
            fn: Callable[[], Any],
            *,
            chunk_idx: int | None = None,
            fraction: float | None = None,
        ) -> Any:
            stop = threading.Event()

            def beat() -> None:
                while not stop.wait(2.0):
                    try:
                        progress(
                            phase,
                            message,
                            chunk_idx=chunk_idx,
                            fraction=fraction,
                        )
                    except Exception:  # noqa: BLE001
                        pass

            thread = threading.Thread(
                target=beat,
                name=f"timbre-progress-{synthesis_id}",
                daemon=True,
            )
            thread.start()
            try:
                return fn()
            finally:
                stop.set()
                thread.join(timeout=0.2)

        def fallback_to_cpu(
            reason: str,
            phase: str,
            message: str,
            *,
            chunk_idx: int | None = None,
            fraction: float | None = None,
        ) -> TTSAdapter:
            nonlocal adapter, cached_payload, fallback_device, fallback_reason
            context = f"synth.{phase}"
            if chunk_idx is not None:
                context = f"{context}.chunk_{chunk_idx + 1}"
            log_cpu_handoff(
                context=context,
                model_id=model_id,
                requested_device=device,
                reason=reason,
            )
            label = device_label(device)
            fallback_device = "cpu"
            fallback_reason = reason
            voicelib.update_synthesis_device(
                synthesis_id,
                fallback_device=fallback_device,
                fallback_reason=fallback_reason,
            )
            warning = f"{label} failed; retrying on CPU: {reason}"
            progress(
                phase,
                f"{label} failed; retrying on CPU",
                chunk_idx=chunk_idx,
                fraction=fraction,
                extra={"warnings": [warning]},
            )
            adapter = with_heartbeat(
                "loading_model",
                f"reloading {info.name} on CPU",
                lambda: _ADAPTERS.reload_on_cpu(model_id, adapter),
                chunk_idx=chunk_idx,
                fraction=fraction,
            )
            if cached_payload is not None:
                cached_payload = adapter.move_payload_to_device(cached_payload, "cpu")
            diag = _adapter_diagnostics(adapter)
            voicelib.update_synthesis_device(
                synthesis_id,
                resolved_device=diag.get("resolved_device"),
                device_detail=diag.get("device_detail"),
            )
            progress(
                phase,
                message,
                chunk_idx=chunk_idx,
                fraction=fraction,
                extra={"warnings": ["using CPU fallback for this run"]},
            )
            return adapter

        _activate_synthesis_run(synthesis_id)
        progress("starting", "starting synthesis", fraction=0.0)
        notify("synth.started", {
            "synthesis_id": synthesis_id,
            "chunk_count": len(chunks),
        })

        progress("loading_model", f"loading {info.name}", fraction=0.05)
        try:
            adapter = with_heartbeat(
                "loading_model",
                f"loading {info.name}",
                lambda: _ADAPTERS.ensure_loaded(model_id, device),
                fraction=0.05,
            )
        except Exception as e:
            reason = accelerator_retry_reason(e, device, adapter)
            if reason is None:
                voicelib.update_synthesis_status(synthesis_id, "failed")
                progress("failed", "model load failed", fraction=None)
                raise
            try:
                adapter = fallback_to_cpu(
                    reason,
                    "loading_model",
                    "model ready on CPU",
                    fraction=0.08,
                )
            except Exception:
                voicelib.update_synthesis_status(synthesis_id, "failed")
                progress("failed", "CPU fallback model load failed", fraction=None)
                raise
        progress("loading_model", "model ready", fraction=0.15)
        diag = _adapter_diagnostics(adapter)
        voicelib.update_synthesis_device(
            synthesis_id,
            resolved_device=diag.get("resolved_device"),
            device_detail=diag.get("device_detail"),
        )
        notify("synth.model_loaded", {
            "model_id": model_id,
            "requested_device": device,
            **diag,
        })

        # Voice-clone prompt: prefer the persisted artefact, fall back to
        # building + saving on the fly. Encoding the reference is the
        # slowest non-generation step for Qwen3 and stays the same across
        # synths with the same (voice, model), so we cache it on disk.
        existing = existing_prompt
        if existing and existing.exists():
            progress("loading_prompt", "loading cached voice prompt", fraction=0.20)
            try:
                payload_device = (
                    adapter.diagnostics().get("resolved_device")
                    or adapter._resolve_torch_device(device)
                )
                cached_payload = adapter.deserialize_payload(
                    existing.read_bytes(), payload_device,
                )
                notify("synth.prompt_loaded", {"path": str(existing), "fresh": False})
                progress("loading_prompt", "cached voice prompt ready", fraction=0.25)
            except Exception as e:  # noqa: BLE001
                notify("synth.prompt_warning", {"error": f"reload failed: {e}"})
                if prompt_only:
                    message = "cached prompt reload failed; prompt-only voice has no source recording"
                    voicelib.update_synthesis_status(synthesis_id, "failed")
                    progress(
                        "failed",
                        message,
                        fraction=None,
                        extra={"warnings": [f"cached prompt reload failed: {e}"]},
                    )
                    raise RpcError(ERR_INVALID_PARAMS, message) from e
                progress(
                    "loading_prompt",
                    "cached prompt reload failed; rebuilding",
                    fraction=0.22,
                    extra={"warnings": [f"cached prompt reload failed: {e}"]},
                )
                cached_payload = None

        if cached_payload is None:
            if prompt_only:
                message = f"prompt-only voice does not include a usable cached prompt for {info.name}"
                voicelib.update_synthesis_status(synthesis_id, "failed")
                progress("failed", message, fraction=None)
                raise RpcError(ERR_INVALID_PARAMS, message)
            progress("encoding_prompt", "encoding reference voice prompt", fraction=0.25)
            try:
                clone_result = with_heartbeat(
                    "encoding_prompt",
                    "encoding reference voice prompt",
                    lambda: adapter.clone(ref_path, ref_transcript),
                    fraction=0.25,
                )
            except Exception as e:  # noqa: BLE001
                reason = accelerator_retry_reason(e, device, adapter)
                if reason is None:
                    notify("synth.clone_warning", {"error": str(e)})
                    progress(
                        "encoding_prompt",
                        "voice prompt encode failed; generating from reference",
                        fraction=0.34,
                        extra={"warnings": [f"prompt encode failed: {e}"]},
                    )
                    clone_result = None
                else:
                    try:
                        fallback_to_cpu(
                            reason,
                            "encoding_prompt",
                            "encoding reference voice prompt",
                            fraction=0.25,
                        )
                        clone_result = with_heartbeat(
                            "encoding_prompt",
                            "encoding reference voice prompt",
                            lambda: adapter.clone(ref_path, ref_transcript),
                            fraction=0.25,
                        )
                    except Exception as retry_err:  # noqa: BLE001
                        notify("synth.clone_warning", {"error": str(retry_err)})
                        progress(
                            "encoding_prompt",
                            "voice prompt encode failed; generating from reference",
                            fraction=0.34,
                            extra={"warnings": [f"prompt encode failed: {retry_err}"]},
                        )
                        clone_result = None
            if clone_result is not None and clone_result.payload is not None:
                cached_payload = clone_result.payload
                progress("encoding_prompt", "voice prompt encoded", fraction=0.32)
                # Persist for future synths.
                try:
                    from timbre.paths import voices_dir
                    out_dir = voices_dir() / voice_id / "embeddings"
                    out_dir.mkdir(parents=True, exist_ok=True)
                    out_path = out_dir / f"{model_id}.pkl"
                    out_path.write_bytes(
                        adapter.serialize_payload(cached_payload)
                    )
                    voicelib.set_embedding(voice_id, model_id, out_path)
                    notify("synth.prompt_saved", {"path": str(out_path)})
                    progress("encoding_prompt", "voice prompt cached", fraction=0.34)
                except Exception as save_err:  # noqa: BLE001
                    notify("synth.prompt_warning", {"error": f"save failed: {save_err}"})
                    progress(
                        "encoding_prompt",
                        "voice prompt cache save failed",
                        fraction=0.34,
                        extra={"warnings": [f"prompt save failed: {save_err}"]},
                    )

        chunk_records = []
        try:
            for ch in chunks:
                base_fraction = 0.35 + 0.55 * (ch.idx / max(len(chunks), 1))
                chunk_seed = seed if seed is not None else (hash((synthesis_id, ch.idx)) & 0x7FFFFFFF)
                cid = voicelib.insert_chunk(
                    synthesis_id=synthesis_id, idx=ch.idx, text=ch.text, seed=chunk_seed,
                )
                t0 = time.time()
                progress(
                    "generating_chunk",
                    f"generating chunk {ch.idx + 1} of {len(chunks)}",
                    chunk_idx=ch.idx,
                    fraction=base_fraction,
                )
                try:
                    samples, sr = with_heartbeat(
                        "generating_chunk",
                        f"generating chunk {ch.idx + 1} of {len(chunks)}",
                        lambda: adapter.synthesize(
                            ch.text, ref_path, ref_transcript,
                            cached_payload=cached_payload,
                            seed=chunk_seed, params=params,
                        ),
                        chunk_idx=ch.idx,
                        fraction=base_fraction,
                    )
                except Exception as e:
                    reason = accelerator_retry_reason(e, device, adapter)
                    if reason is None:
                        raise
                    fallback_to_cpu(
                        reason,
                        "generating_chunk",
                        f"generating chunk {ch.idx + 1} of {len(chunks)}",
                        chunk_idx=ch.idx,
                        fraction=base_fraction,
                    )
                    samples, sr = with_heartbeat(
                        "generating_chunk",
                        f"generating chunk {ch.idx + 1} of {len(chunks)}",
                        lambda: adapter.synthesize(
                            ch.text, ref_path, ref_transcript,
                            cached_payload=cached_payload,
                            seed=chunk_seed, params=params,
                        ),
                        chunk_idx=ch.idx,
                        fraction=base_fraction,
                    )
                progress(
                    "writing_audio",
                    f"writing chunk {ch.idx + 1} of {len(chunks)}",
                    chunk_idx=ch.idx,
                    fraction=base_fraction + (0.45 / max(len(chunks), 1)),
                )
                audio_path = clips_dir() / synthesis_id / f"{ch.idx:04d}.wav"
                write_wav(audio_path, samples, sr)
                duration_ms = int(len(samples) * 1000 / sr)
                voicelib.update_chunk_result(
                    cid, audio_path=str(audio_path), duration_ms=duration_ms,
                )
                elapsed_ms = int((time.time() - t0) * 1000)
                chunk_records.append({
                    "id": cid, "idx": ch.idx, "audio_path": str(audio_path),
                    "duration_ms": duration_ms, "elapsed_ms": elapsed_ms, "text": ch.text,
                })
                notify("synth.chunk_ready", chunk_records[-1])

            progress("finalizing", "building playable full-run WAV", fraction=0.95)
            final = _rebuild_final_audio(synthesis_id)
        except Exception:
            voicelib.update_synthesis_status(synthesis_id, "failed")
            progress("failed", "synthesis failed", fraction=None)
            raise

        finished = {"synthesis_id": synthesis_id, **final}
        progress("complete", "synthesis complete", fraction=1.0)
        notify("synth.finished", finished)
        return {"synthesis_id": synthesis_id, "chunks": chunk_records, **final}

    @rpc.method("synth.regenerate_chunk", streaming=True)
    def synth_regenerate_chunk(
        notify: Callable[..., None],
        chunk_id: str,
        seed: int | None = None,
        text_override: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict:
        if _running_synthesis_id() is not None:
            raise RpcError(ERR_INVALID_PARAMS, "cannot regenerate chunks while synthesis is running")
        import sqlite3
        from timbre.paths import db_path
        with sqlite3.connect(str(db_path())) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM chunk WHERE id=?", (chunk_id,)).fetchone()
            if row is None:
                raise RpcError(ERR_INVALID_PARAMS, f"chunk not found: {chunk_id}")
            synth = conn.execute(
                "SELECT * FROM synthesis WHERE id=?", (row["synthesis_id"],),
            ).fetchone()
        text = text_override if text_override is not None else row["text"]
        if not text.strip():
            raise RpcError(ERR_INVALID_PARAMS, "chunk text is empty")
        chunk_seed = seed if seed is not None else row["seed"]
        parent_params: dict[str, Any] = {}
        if synth["params_json"]:
            try:
                decoded_params = json.loads(synth["params_json"])
                if isinstance(decoded_params, dict):
                    parent_params = decoded_params
            except (TypeError, ValueError):
                parent_params = {}
        parent_params.pop("seed", None)
        params_override = params if params is not None else {}
        effective_params = {
            k: v
            for k, v in {**parent_params, **params_override}.items()
            if k != "seed"
        }
        info = get(synth["model_id"])
        effective_params = _validate_synth_params(info, effective_params)
        voice = voicelib.get_voice(synth["voice_id"])
        requested_device = _ADAPTERS.current_device() or synth["requested_device"] or "cpu"
        prompt_only = bool(voice.get("prompt_only"))
        existing_prompt = voicelib.get_embedding_path(synth["voice_id"], synth["model_id"])
        if prompt_only and not (existing_prompt and existing_prompt.exists()):
            raise RpcError(
                ERR_INVALID_PARAMS,
                "prompt-only voice does not include a cached prompt for this model",
            )
        ref_path_2 = Path(voice["ref_audio_path"])
        ref_text_2 = voice.get("ref_transcript")
        with _ADAPTERS.operation():
            adapter = _ADAPTERS.ensure_loaded(synth["model_id"], requested_device)
            cached_payload = None
            if existing_prompt and existing_prompt.exists():
                try:
                    payload_device = (
                        adapter.diagnostics().get("resolved_device")
                        or adapter._resolve_torch_device(requested_device)
                    )
                    cached_payload = adapter.deserialize_payload(
                        existing_prompt.read_bytes(), payload_device,
                    )
                except Exception as e:  # noqa: BLE001
                    if prompt_only:
                        raise RpcError(
                            ERR_INVALID_PARAMS,
                            "cached prompt reload failed; prompt-only voice has no source recording",
                        ) from e
            if cached_payload is None:
                if prompt_only:
                    raise RpcError(
                        ERR_INVALID_PARAMS,
                        "prompt-only voice does not include a usable cached prompt for this model",
                    )
                clone_result = None
                try:
                    clone_result = adapter.clone(ref_path_2, ref_text_2)
                except Exception:  # noqa: BLE001
                    pass
                cached_payload = clone_result.payload if clone_result is not None else None
            try:
                samples, sr = adapter.synthesize(
                    text,
                    ref_path_2,
                    ref_text_2,
                    cached_payload=cached_payload,
                    seed=chunk_seed,
                    params=effective_params,
                )
            except Exception as e:
                reason = accelerator_retry_reason(e, requested_device, adapter)
                if reason is None:
                    raise
                label = device_label(requested_device)
                notify("synth.warning", {
                    "warning": f"{label} failed during chunk regeneration; retrying on CPU: {reason}",
                })
                log_cpu_handoff(
                    context="synth.regenerate_chunk",
                    model_id=synth["model_id"],
                    requested_device=requested_device,
                    reason=reason,
                )
                voicelib.update_synthesis_device(
                    synth["id"],
                    fallback_device="cpu",
                    fallback_reason=reason,
                )
                adapter = _ADAPTERS.reload_on_cpu(synth["model_id"], adapter)
                if cached_payload is not None:
                    cached_payload = adapter.move_payload_to_device(cached_payload, "cpu")
                samples, sr = adapter.synthesize(
                    text,
                    ref_path_2,
                    ref_text_2,
                    cached_payload=cached_payload,
                    seed=chunk_seed,
                    params=effective_params,
                )
        diag = _adapter_diagnostics(adapter)
        voicelib.update_synthesis_device(
            synth["id"],
            resolved_device=diag.get("resolved_device"),
            device_detail=diag.get("device_detail"),
        )
        audio_path = clips_dir() / synth["id"] / f"{row['idx']:04d}.wav"
        write_wav(audio_path, samples, sr)
        duration_ms = int(len(samples) * 1000 / sr)
        voicelib.update_chunk_result(
            chunk_id,
            audio_path=str(audio_path),
            duration_ms=duration_ms,
            text=text,
            seed=chunk_seed,
            params_override=params_override,
        )
        final = _rebuild_final_audio(synth["id"])
        notify("synth.chunk_ready", {
            "id": chunk_id, "idx": row["idx"], "audio_path": str(audio_path),
            "duration_ms": duration_ms, "text": text, "seed": chunk_seed,
            "revision": int(row["revision"] or 1) + 1,
            "params_override": params_override,
        })
        notify("synth.updated", {"synthesis_id": synth["id"], **final})
        return {
            "id": chunk_id,
            "synthesis_id": synth["id"],
            "idx": row["idx"],
            "audio_path": str(audio_path),
            "duration_ms": duration_ms,
            "text": text,
            "seed": chunk_seed,
            "revision": int(row["revision"] or 1) + 1,
            "params_override": params_override,
            **final,
        }

    @rpc.method("synth.list_chunks")
    def synth_list_chunks(synthesis_id: str) -> list[dict]:
        return voicelib.list_chunks(synthesis_id)

    @rpc.method("shutdown")
    def shutdown() -> dict:
        _ADAPTERS.unload_all()
        # Returning is enough; the Rust shell will close stdin and we exit.
        return {"ok": True}

    return rpc


def main() -> None:
    rpc = build_server()
    try:
        rpc.serve()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
