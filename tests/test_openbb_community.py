"""Offline tests for the pinned OpenBB Community source patch."""

from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = REPO_ROOT / "tools/openbb/community/apply_patch.py"
PATCH_PATH = REPO_ROOT / "tools/openbb/community/patches/community.patch"
MANIFEST_PATH = PATCH_PATH.with_name(PATCH_PATH.name + ".json")
SPEC = importlib.util.spec_from_file_location("openbb_community_patch", RUNNER_PATH)
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class OpenBBCommunityPatchTests(unittest.TestCase):
    def test_patch_and_manifest_are_pinned_and_path_complete(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(manifest["upstream"]["repository"], "OpenBB-finance/workspace")
        self.assertEqual(
            manifest["upstream"]["commit"],
            "be00e95019a55d57af146919ee46b7e1a4859226",
        )
        self.assertEqual(
            manifest["upstream"]["archive_sha256"],
            "4171aa8984c7c63e171239f8cda72c4bc950f1e068de33577035dc8e5d63e6a4",
        )
        paths = {change["path"].as_posix() for change in RUNNER.parse_patch(PATCH_PATH.read_bytes())}
        self.assertEqual(paths, set(manifest["preimages"]))
        self.assertEqual(paths, set(manifest["postimages"]))
        self.assertEqual(len(paths), 36)

    def test_patch_does_not_publish_upstream_enterprise_license_key(self) -> None:
        patch = PATCH_PATH.read_text(encoding="utf-8")
        runner = RUNNER_PATH.read_text(encoding="utf-8")
        self.assertNotRegex(patch + runner, r"AG-\d{6}")
        self.assertNotIn("Using_this_", patch + runner)

    def test_exact_hunk_application_keeps_community_only_lines(self) -> None:
        hunk = {
            "old_start": 2,
            "old_count": 2,
            "old": ["enterprise\n", "keep\n"],
            "new": ["community\n", "keep\n"],
        }
        result = RUNNER.apply_hunks(["before\n", "enterprise\n", "keep\n", "after\n"], [hunk], "terminalpro/grid.ts")
        self.assertEqual(result, ["before\n", "community\n", "keep\n", "after\n"])

    def test_exact_hunk_application_rejects_source_drift(self) -> None:
        hunk = {
            "old_start": 1,
            "old_count": 1,
            "old": ["pinned upstream\n"],
            "new": ["community adapter\n"],
        }
        with self.assertRaises(RUNNER.PatchError):
            RUNNER.apply_hunks(["unexpected upstream\n"], [hunk], "terminalpro/grid.ts")

    def test_patch_rejects_paths_outside_workspace_trees(self) -> None:
        patch = b"--- a/terminalpro/../../outside\n+++ b/terminalpro/../../outside\n@@ -1 +1 @@\n-old\n+new\n"
        with self.assertRaises(RUNNER.PatchError):
            RUNNER.parse_patch(patch)

    def test_runner_rejects_unpinned_source_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openbb-community-unpinned-") as temp:
            with self.assertRaises(RUNNER.PatchError):
                RUNNER.apply(Path(temp), [PATCH_PATH])


if __name__ == "__main__":
    unittest.main()
