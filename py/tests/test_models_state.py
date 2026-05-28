from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from timbre import models_state, paths  # noqa: E402


class ModelsStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_data_dir = os.environ.get("TIMBRE_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["TIMBRE_DATA_DIR"] = self._tmp.name
        paths.data_dir.cache_clear()
        paths.cache_dir.cache_clear()

    def tearDown(self) -> None:
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TIMBRE_DATA_DIR", None)
        else:
            os.environ["TIMBRE_DATA_DIR"] = self._old_data_dir
        paths.data_dir.cache_clear()
        paths.cache_dir.cache_clear()

    def test_sibling_blob_id_prefers_lfs_sha256(self) -> None:
        sibling = SimpleNamespace(
            blob_id="git-pointer-hash",
            lfs={"sha256": "lfs-payload-sha256", "oid": "lfs-payload-oid"},
        )

        self.assertEqual(models_state._sibling_blob_id(sibling), "lfs-payload-sha256")

    def test_sibling_blob_id_uses_lfs_oid_without_sha256(self) -> None:
        sibling = SimpleNamespace(
            blob_id="git-pointer-hash",
            lfs=SimpleNamespace(oid="lfs-payload-oid"),
        )

        self.assertEqual(models_state._sibling_blob_id(sibling), "lfs-payload-oid")

    def test_sibling_blob_id_falls_back_to_regular_blob_id(self) -> None:
        sibling = SimpleNamespace(blob_id="regular-blob-hash", lfs=None)

        self.assertEqual(models_state._sibling_blob_id(sibling), "regular-blob-hash")

    def test_file_state_counts_lfs_incomplete_bytes(self) -> None:
        info = SimpleNamespace(hf_repo="Owner/Repo")
        plan = models_state.DownloadPlan(
            files=(
                models_state.DownloadPlanFile(
                    path="model.safetensors",
                    size=100,
                    blob_id="lfs-payload-sha256",
                ),
            ),
            expected_bytes=100,
            total_known=True,
            source="hf",
        )
        repo_dir = paths.models_dir() / "models--Owner--Repo"
        blobs_dir = repo_dir / "blobs"
        blobs_dir.mkdir(parents=True)
        (blobs_dir / "lfs-payload-sha256.incomplete").write_bytes(b"x" * 37)

        state = models_state._file_state(info, plan)

        self.assertEqual(state["downloaded_bytes"], 37)
        self.assertEqual(state["installed_bytes"], 0)
        self.assertEqual(state["files_done"], 0)
        self.assertEqual(state["files_total"], 1)


if __name__ == "__main__":
    unittest.main()
