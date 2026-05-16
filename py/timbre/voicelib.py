"""Voice library + synthesis history persisted in sqlite.

Schema is intentionally minimal — embeddings are file payloads referenced by
voice_id+model_id rather than blobs in the DB."""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from timbre.paths import db_path

PROMPT_ONLY_SOURCE_NOTE = "prompt_only_import"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS voice (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_current INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ref_audio_path TEXT NOT NULL,
    ref_audio_sr INTEGER NOT NULL,
    ref_transcript TEXT,
    ref_duration_ms INTEGER NOT NULL,
    source_notes TEXT,
    deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS voice_embedding (
    voice_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    payload_path TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (voice_id, model_id),
    FOREIGN KEY (voice_id) REFERENCES voice(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS synthesis (
    id TEXT PRIMARY KEY,
    voice_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    full_text TEXT NOT NULL,
    params_json TEXT NOT NULL,
    requested_device TEXT NOT NULL,
    resolved_device TEXT,
    device_detail TEXT,
    fallback_device TEXT,
    fallback_reason TEXT,
    final_audio_path TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    batch_id TEXT,
    batch_index INTEGER,
    batch_count INTEGER,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    voice_name_snapshot TEXT,
    voice_version_snapshot INTEGER,
    model_name_snapshot TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (voice_id) REFERENCES voice(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chunk (
    id TEXT PRIMARY KEY,
    synthesis_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    seed INTEGER NOT NULL,
    audio_path TEXT,
    duration_ms INTEGER,
    params_override_json TEXT,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (synthesis_id) REFERENCES synthesis(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunk_synthesis ON chunk(synthesis_id, idx);
"""


@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    c = sqlite3.connect(str(db_path()))
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init_db() -> None:
    with _conn() as c:
        c.executescript(_SCHEMA)
        _migrate_schema(c)


def _migrate_schema(c: sqlite3.Connection) -> None:
    voice_columns = {
        row["name"]
        for row in c.execute("PRAGMA table_info(voice)").fetchall()
    }
    if "deleted_at" not in voice_columns:
        c.execute("ALTER TABLE voice ADD COLUMN deleted_at INTEGER")

    synthesis_columns = {
        row["name"]
        for row in c.execute("PRAGMA table_info(synthesis)").fetchall()
    }
    additions = {
        "batch_id": "ALTER TABLE synthesis ADD COLUMN batch_id TEXT",
        "batch_index": "ALTER TABLE synthesis ADD COLUMN batch_index INTEGER",
        "batch_count": "ALTER TABLE synthesis ADD COLUMN batch_count INTEGER",
        "is_favorite": "ALTER TABLE synthesis ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
        "voice_name_snapshot": "ALTER TABLE synthesis ADD COLUMN voice_name_snapshot TEXT",
        "voice_version_snapshot": "ALTER TABLE synthesis ADD COLUMN voice_version_snapshot INTEGER",
        "model_name_snapshot": "ALTER TABLE synthesis ADD COLUMN model_name_snapshot TEXT",
    }
    for column, statement in additions.items():
        if column not in synthesis_columns:
            c.execute(statement)

    chunk_columns = {
        row["name"]
        for row in c.execute("PRAGMA table_info(chunk)").fetchall()
    }
    chunk_additions = {
        "params_override_json": "ALTER TABLE chunk ADD COLUMN params_override_json TEXT",
        "revision": "ALTER TABLE chunk ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    }
    for column, statement in chunk_additions.items():
        if column not in chunk_columns:
            c.execute(statement)
    _backfill_synthesis_snapshots(c)


def _known_model_names() -> dict[str, str]:
    try:
        from timbre.registry import all_models

        return {model.id: model.name for model in all_models()}
    except Exception:  # noqa: BLE001
        return {}


def _backfill_synthesis_snapshots(c: sqlite3.Connection) -> None:
    c.execute(
        """
        UPDATE synthesis
        SET voice_name_snapshot = COALESCE(
            NULLIF(voice_name_snapshot, ''),
            (SELECT name FROM voice WHERE voice.id = synthesis.voice_id),
            voice_id
        )
        WHERE voice_name_snapshot IS NULL OR voice_name_snapshot = ''
        """
    )
    c.execute(
        """
        UPDATE synthesis
        SET voice_version_snapshot = COALESCE(
            voice_version_snapshot,
            (SELECT version FROM voice WHERE voice.id = synthesis.voice_id),
            1
        )
        WHERE voice_version_snapshot IS NULL
        """
    )
    for model_id, model_name in _known_model_names().items():
        c.execute(
            """
            UPDATE synthesis
            SET model_name_snapshot = ?
            WHERE model_id = ?
              AND (model_name_snapshot IS NULL OR model_name_snapshot = '')
            """,
            (model_name, model_id),
        )
    c.execute(
        """
        UPDATE synthesis
        SET model_name_snapshot = COALESCE(NULLIF(model_name_snapshot, ''), model_id)
        WHERE model_name_snapshot IS NULL OR model_name_snapshot = ''
        """
    )


# --- Voices ---------------------------------------------------------------

def create_voice(
    *,
    name: str,
    ref_audio_path: str,
    ref_audio_sr: int,
    ref_duration_ms: int,
    ref_transcript: str | None = None,
    source_notes: str | None = None,
    voice_id: str | None = None,
) -> dict[str, Any]:
    vid = voice_id or str(uuid.uuid4())
    now = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "INSERT INTO voice(id,root_id,version,is_current,name,created_at,"
            "ref_audio_path,ref_audio_sr,ref_transcript,ref_duration_ms,source_notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (vid, vid, 1, 1, name, now, ref_audio_path, ref_audio_sr, ref_transcript,
             ref_duration_ms, source_notes),
        )
    return get_voice(vid)


def create_voice_version(
    voice_id: str,
    *,
    name: str,
    ref_audio_path: str,
    ref_audio_sr: int,
    ref_duration_ms: int,
    ref_transcript: str | None = None,
    source_notes: str | None = None,
    new_voice_id: str | None = None,
) -> dict[str, Any]:
    old = get_voice(voice_id)
    root_id = old["root_id"]
    vid = new_voice_id or str(uuid.uuid4())
    now = int(time.time() * 1000)
    with _conn() as c:
        row = c.execute(
            "SELECT COALESCE(MAX(version), 0) AS max_version FROM voice WHERE root_id=?",
            (root_id,),
        ).fetchone()
        version = int(row["max_version"] or 0) + 1
        c.execute("UPDATE voice SET is_current=0 WHERE root_id=?", (root_id,))
        c.execute(
            "INSERT INTO voice(id,root_id,version,is_current,name,created_at,"
            "ref_audio_path,ref_audio_sr,ref_transcript,ref_duration_ms,source_notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (vid, root_id, version, 1, name, now, ref_audio_path, ref_audio_sr,
             ref_transcript, ref_duration_ms, source_notes),
        )
    return get_voice(vid)


def create_prompt_only_voice(
    *,
    name: str,
    source_notes: str = PROMPT_ONLY_SOURCE_NOTE,
    voice_id: str | None = None,
) -> dict[str, Any]:
    vid = voice_id or str(uuid.uuid4())
    now = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "INSERT INTO voice(id,root_id,version,is_current,name,created_at,"
            "ref_audio_path,ref_audio_sr,ref_transcript,ref_duration_ms,source_notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (vid, vid, 1, 1, name, now, "", 0, None, 0, source_notes),
        )
    return get_voice(vid)


def get_voice(voice_id: str, *, include_deleted: bool = False) -> dict[str, Any]:
    with _conn() as c:
        if include_deleted:
            row = c.execute("SELECT * FROM voice WHERE id=?", (voice_id,)).fetchone()
        else:
            row = c.execute(
                "SELECT * FROM voice WHERE id=? AND deleted_at IS NULL",
                (voice_id,),
            ).fetchone()
    if row is None:
        raise KeyError(f"voice not found: {voice_id}")
    return _voice_row_to_dict(row)


def list_voices(current_only: bool = True) -> list[dict[str, Any]]:
    with _conn() as c:
        query = (
            "SELECT * FROM voice WHERE is_current=1 AND deleted_at IS NULL ORDER BY created_at DESC"
            if current_only
            else "SELECT * FROM voice WHERE deleted_at IS NULL ORDER BY created_at DESC"
        )
        rows = c.execute(query).fetchall()
    return [_voice_row_to_dict(r) for r in rows]


def delete_voice(voice_id: str) -> list[str]:
    voice = get_voice(voice_id)
    root_id = voice["root_id"]
    now = int(time.time() * 1000)
    with _conn() as c:
        rows = c.execute(
            "SELECT id FROM voice WHERE root_id=? AND deleted_at IS NULL",
            (root_id,),
        ).fetchall()
        ids = [r["id"] for r in rows]
        c.execute(
            "UPDATE voice SET deleted_at=?, is_current=0 WHERE root_id=? AND deleted_at IS NULL",
            (now, root_id),
        )
        c.execute(
            "DELETE FROM voice_embedding WHERE voice_id IN (SELECT id FROM voice WHERE root_id=?)",
            (root_id,),
        )
    return ids


def hard_delete_voice(voice_id: str) -> list[str]:
    with _conn() as c:
        row = c.execute("SELECT root_id FROM voice WHERE id=?", (voice_id,)).fetchone()
        if row is None:
            return []
        root_id = row["root_id"]
        rows = c.execute("SELECT id FROM voice WHERE root_id=?", (root_id,)).fetchall()
        ids = [r["id"] for r in rows]
        c.execute("DELETE FROM voice WHERE root_id=?", (root_id,))
    return ids


def set_embedding(voice_id: str, model_id: str, payload_path: Path) -> None:
    now = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO voice_embedding"
            "(voice_id,model_id,payload_path,schema_version,created_at)"
            " VALUES (?,?,?,?,?)",
            (voice_id, model_id, str(payload_path), 1, now),
        )


def get_embedding_path(voice_id: str, model_id: str) -> Path | None:
    with _conn() as c:
        row = c.execute(
            "SELECT payload_path FROM voice_embedding WHERE voice_id=? AND model_id=?",
            (voice_id, model_id),
        ).fetchone()
    return Path(row[0]) if row else None


def list_embeddings(voice_id: str) -> list[dict[str, Any]]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM voice_embedding WHERE voice_id=? ORDER BY model_id",
            (voice_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def embedding_count(voice_id: str) -> int:
    with _conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS count FROM voice_embedding WHERE voice_id=?",
            (voice_id,),
        ).fetchone()
    return int(row["count"] or 0)


# --- Synthesis history ----------------------------------------------------

def create_synthesis(
    *,
    voice_id: str,
    model_id: str,
    full_text: str,
    params: dict,
    requested_device: str,
    voice_name_snapshot: str | None = None,
    voice_version_snapshot: int | None = None,
    model_name_snapshot: str | None = None,
    batch_id: str | None = None,
    batch_index: int | None = None,
    batch_count: int | None = None,
) -> str:
    sid = str(uuid.uuid4())
    now = int(time.time() * 1000)
    with _conn() as c:
        voice_row = c.execute(
            "SELECT name, version FROM voice WHERE id=?",
            (voice_id,),
        ).fetchone()
        resolved_voice_name = (
            voice_name_snapshot
            or (voice_row["name"] if voice_row is not None else None)
            or voice_id
        )
        resolved_voice_version = (
            voice_version_snapshot
            if voice_version_snapshot is not None
            else int(voice_row["version"] if voice_row is not None else 1)
        )
        resolved_model_name = model_name_snapshot or _known_model_names().get(model_id) or model_id
        c.execute(
            "INSERT INTO synthesis(id,voice_id,model_id,full_text,params_json,"
            "requested_device,status,batch_id,batch_index,batch_count,"
            "voice_name_snapshot,voice_version_snapshot,model_name_snapshot,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                sid,
                voice_id,
                model_id,
                full_text,
                json.dumps(params),
                requested_device,
                "running",
                batch_id,
                batch_index,
                batch_count,
                resolved_voice_name,
                resolved_voice_version,
                resolved_model_name,
                now,
                now,
            ),
        )
    return sid


def update_synthesis_device(
    synthesis_id: str,
    *,
    resolved_device: str | None = None,
    device_detail: str | None = None,
    fallback_device: str | None = None,
    fallback_reason: str | None = None,
) -> None:
    now = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            """
            UPDATE synthesis
            SET resolved_device=COALESCE(?, resolved_device),
                device_detail=COALESCE(?, device_detail),
                fallback_device=COALESCE(?, fallback_device),
                fallback_reason=COALESCE(?, fallback_reason),
                updated_at=?
            WHERE id=?
            """,
            (
                resolved_device,
                device_detail,
                fallback_device,
                fallback_reason,
                now,
                synthesis_id,
            ),
        )


def update_synthesis_result(
    synthesis_id: str,
    *,
    final_audio_path: str,
    duration_ms: int,
    status: str = "ready",
) -> None:
    now = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "UPDATE synthesis SET final_audio_path=?, duration_ms=?, status=?, updated_at=? "
            "WHERE id=?",
            (final_audio_path, duration_ms, status, now, synthesis_id),
        )


def update_synthesis_status(synthesis_id: str, status: str) -> None:
    now = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "UPDATE synthesis SET status=?, updated_at=? WHERE id=?",
            (status, now, synthesis_id),
        )


def set_synthesis_favorite(synthesis_id: str) -> None:
    row = get_synthesis(synthesis_id)
    now = int(time.time() * 1000)
    with _conn() as c:
        if row.get("batch_id"):
            c.execute(
                "UPDATE synthesis SET is_favorite=0, updated_at=? WHERE batch_id=?",
                (now, row["batch_id"]),
            )
        else:
            c.execute(
                "UPDATE synthesis SET is_favorite=0, updated_at=? WHERE id=?",
                (now, synthesis_id),
            )
        c.execute(
            "UPDATE synthesis SET is_favorite=1, updated_at=? WHERE id=?",
            (now, synthesis_id),
        )


def get_synthesis(synthesis_id: str) -> dict[str, Any]:
    with _conn() as c:
        row = c.execute(
            """
            SELECT s.*,
                   COALESCE(NULLIF(s.voice_name_snapshot, ''), v.name, s.voice_id) AS voice_name,
                   COALESCE(s.voice_version_snapshot, v.version, 1) AS voice_version,
                   COALESCE(NULLIF(s.model_name_snapshot, ''), s.model_id) AS model_name,
                   CASE WHEN v.id IS NULL OR v.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS voice_deleted
            FROM synthesis s
            LEFT JOIN voice v ON v.id = s.voice_id
            WHERE s.id=?
            """,
            (synthesis_id,),
        ).fetchone()
    if row is None:
        raise KeyError(f"synthesis not found: {synthesis_id}")
    return dict(row)


def list_syntheses(limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    with _conn() as c:
        rows = c.execute(
            """
            SELECT s.*,
                   COALESCE(NULLIF(s.voice_name_snapshot, ''), v.name, s.voice_id) AS voice_name,
                   COALESCE(s.voice_version_snapshot, v.version, 1) AS voice_version,
                   COALESCE(NULLIF(s.model_name_snapshot, ''), s.model_id) AS model_name,
                   CASE WHEN v.id IS NULL OR v.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS voice_deleted
            FROM synthesis s
            LEFT JOIN voice v ON v.id = s.voice_id
            ORDER BY s.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def insert_chunk(*, synthesis_id: str, idx: int, text: str, seed: int) -> str:
    cid = str(uuid.uuid4())
    with _conn() as c:
        c.execute(
            "INSERT INTO chunk(id,synthesis_id,idx,text,seed,status) VALUES (?,?,?,?,?,'pending')",
            (cid, synthesis_id, idx, text, seed),
        )
    return cid


def update_chunk_result(
    chunk_id: str,
    *,
    audio_path: str,
    duration_ms: int,
    status: str = "ready",
    text: str | None = None,
    seed: int | None = None,
    params_override: dict[str, Any] | None = None,
) -> None:
    params_json = json.dumps(params_override) if params_override is not None else None
    with _conn() as c:
        c.execute(
            """
            UPDATE chunk
            SET audio_path=?,
                duration_ms=?,
                status=?,
                text=COALESCE(?, text),
                seed=COALESCE(?, seed),
                params_override_json=COALESCE(?, params_override_json),
                revision=revision+1
            WHERE id=?
            """,
            (
                audio_path,
                duration_ms,
                status,
                text,
                seed,
                params_json,
                chunk_id,
            ),
        )


def list_chunks(synthesis_id: str) -> list[dict[str, Any]]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM chunk WHERE synthesis_id=? ORDER BY idx", (synthesis_id,)
        ).fetchall()
    return [_chunk_row_to_dict(r) for r in rows]


def _voice_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    d["is_current"] = bool(d["is_current"])
    d["version"] = int(d["version"])
    d["deleted"] = d.get("deleted_at") is not None
    d["prompt_only"] = d.get("source_notes") == PROMPT_ONLY_SOURCE_NOTE
    d["prompt_count"] = embedding_count(d["id"])
    return d


def _chunk_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    raw_params = d.pop("params_override_json", None)
    params_override: dict[str, Any] = {}
    if raw_params:
        try:
            decoded = json.loads(raw_params)
            if isinstance(decoded, dict):
                params_override = decoded
        except (TypeError, ValueError):
            params_override = {}
    d["params_override"] = params_override
    return d
