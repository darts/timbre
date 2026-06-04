from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from timbre import paths, voicelib  # noqa: E402


class VoiceLibCancelTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_data_dir = os.environ.get("TIMBRE_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["TIMBRE_DATA_DIR"] = self._tmp.name
        paths.data_dir.cache_clear()
        paths.cache_dir.cache_clear()
        voicelib.init_db()

    def tearDown(self) -> None:
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TIMBRE_DATA_DIR", None)
        else:
            os.environ["TIMBRE_DATA_DIR"] = self._old_data_dir
        paths.data_dir.cache_clear()
        paths.cache_dir.cache_clear()

    def _create_synthesis(self) -> str:
        voice = voicelib.create_voice(
            name="Test Voice",
            ref_audio_path="/tmp/reference.wav",
            ref_audio_sr=24000,
            ref_duration_ms=1000,
        )
        return voicelib.create_synthesis(
            voice_id=voice["id"],
            model_id="test-model",
            full_text="Hello world.",
            params={},
            requested_device="cpu",
        )

    def test_cancel_synthesis_marks_run_and_pending_chunks_cancelled(self) -> None:
        synthesis_id = self._create_synthesis()
        ready_chunk_id = voicelib.insert_chunk(
            synthesis_id=synthesis_id,
            idx=0,
            text="Hello",
            seed=1,
        )
        pending_chunk_id = voicelib.insert_chunk(
            synthesis_id=synthesis_id,
            idx=1,
            text="world.",
            seed=2,
        )
        self.assertTrue(
            voicelib.update_chunk_result(
                ready_chunk_id,
                audio_path="/tmp/ready.wav",
                duration_ms=500,
            )
        )
        with sqlite3.connect(str(paths.db_path())) as conn:
            conn.execute(
                """
                UPDATE synthesis
                SET final_audio_path='/tmp/stale.wav',
                    duration_ms=999
                WHERE id=?
                """,
                (synthesis_id,),
            )

        row = voicelib.cancel_synthesis(synthesis_id)
        chunks = {chunk["id"]: chunk for chunk in voicelib.list_chunks(synthesis_id)}

        self.assertEqual(row["status"], "cancelled")
        self.assertIsNone(row["final_audio_path"])
        self.assertIsNone(row["duration_ms"])
        self.assertEqual(chunks[ready_chunk_id]["status"], "ready")
        self.assertEqual(chunks[pending_chunk_id]["status"], "cancelled")

    def test_cancel_interrupted_syntheses_recovers_stale_running_rows(self) -> None:
        stale_id = self._create_synthesis()
        ready_chunk_id = voicelib.insert_chunk(
            synthesis_id=stale_id,
            idx=0,
            text="Hello",
            seed=1,
        )
        pending_chunk_id = voicelib.insert_chunk(
            synthesis_id=stale_id,
            idx=1,
            text="world.",
            seed=2,
        )
        self.assertTrue(
            voicelib.update_chunk_result(
                ready_chunk_id,
                audio_path="/tmp/ready.wav",
                duration_ms=500,
            )
        )
        with sqlite3.connect(str(paths.db_path())) as conn:
            conn.execute(
                """
                UPDATE synthesis
                SET final_audio_path='/tmp/stale.wav',
                    duration_ms=999
                WHERE id=?
                """,
                (stale_id,),
            )

        complete_id = self._create_synthesis()
        self.assertTrue(
            voicelib.update_synthesis_result(
                complete_id,
                final_audio_path="/tmp/complete.wav",
                duration_ms=1000,
            )
        )

        recovered = voicelib.cancel_interrupted_syntheses()
        stale = voicelib.get_synthesis(stale_id)
        complete = voicelib.get_synthesis(complete_id)
        chunks = {chunk["id"]: chunk for chunk in voicelib.list_chunks(stale_id)}

        self.assertEqual(recovered, [stale_id])
        self.assertEqual(stale["status"], "cancelled")
        self.assertIsNone(stale["final_audio_path"])
        self.assertIsNone(stale["duration_ms"])
        self.assertEqual(chunks[ready_chunk_id]["status"], "ready")
        self.assertEqual(chunks[pending_chunk_id]["status"], "cancelled")
        self.assertEqual(complete["status"], "ready")
        self.assertEqual(complete["final_audio_path"], "/tmp/complete.wav")

    def test_cancelled_synthesis_cannot_be_overwritten_by_result_or_status(self) -> None:
        synthesis_id = self._create_synthesis()
        voicelib.cancel_synthesis(synthesis_id)

        self.assertFalse(
            voicelib.update_synthesis_result(
                synthesis_id,
                final_audio_path="/tmp/late.wav",
                duration_ms=1000,
            )
        )
        self.assertFalse(voicelib.update_synthesis_status(synthesis_id, "failed"))

        row = voicelib.get_synthesis(synthesis_id)
        self.assertEqual(row["status"], "cancelled")
        self.assertIsNone(row["final_audio_path"])
        self.assertIsNone(row["duration_ms"])

    def test_cancelled_chunk_cannot_be_overwritten_by_result(self) -> None:
        synthesis_id = self._create_synthesis()
        chunk_id = voicelib.insert_chunk(
            synthesis_id=synthesis_id,
            idx=0,
            text="Hello",
            seed=1,
        )
        voicelib.cancel_synthesis(synthesis_id)

        self.assertFalse(
            voicelib.update_chunk_result(
                chunk_id,
                audio_path="/tmp/late.wav",
                duration_ms=500,
            )
        )
        chunk = voicelib.list_chunks(synthesis_id)[0]
        self.assertEqual(chunk["status"], "cancelled")
        self.assertIsNone(chunk["audio_path"])
        self.assertIsNone(chunk["duration_ms"])

    def test_delete_synthesis_removes_row_chunks_and_clip_dir(self) -> None:
        synthesis_id = self._create_synthesis()
        clip_dir = paths.clips_dir() / synthesis_id
        clip_dir.mkdir(parents=True)
        chunk_audio = clip_dir / "0000.wav"
        final_audio = clip_dir / "full.wav"
        chunk_audio.write_bytes(b"chunk")
        final_audio.write_bytes(b"final")
        chunk_id = voicelib.insert_chunk(
            synthesis_id=synthesis_id,
            idx=0,
            text="Hello",
            seed=1,
        )
        self.assertTrue(
            voicelib.update_chunk_result(
                chunk_id,
                audio_path=str(chunk_audio),
                duration_ms=500,
            )
        )
        self.assertTrue(
            voicelib.update_synthesis_result(
                synthesis_id,
                final_audio_path=str(final_audio),
                duration_ms=500,
            )
        )

        deleted = voicelib.delete_syntheses([synthesis_id])

        self.assertEqual(deleted, [synthesis_id])
        with self.assertRaises(KeyError):
            voicelib.get_synthesis(synthesis_id)
        self.assertEqual(voicelib.list_chunks(synthesis_id), [])
        self.assertFalse(clip_dir.exists())

    def test_delete_synthesis_rejects_active_run(self) -> None:
        synthesis_id = self._create_synthesis()
        clip_dir = paths.clips_dir() / synthesis_id
        clip_dir.mkdir(parents=True)

        with self.assertRaises(RuntimeError):
            voicelib.delete_syntheses([synthesis_id])

        self.assertEqual(voicelib.get_synthesis(synthesis_id)["status"], "running")
        self.assertTrue(clip_dir.exists())


if __name__ == "__main__":
    unittest.main()
