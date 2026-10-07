"""Offline tests for the pinned OpenTerminal file-diff report."""

import json
import tempfile
import unittest
from pathlib import Path

from tools.upstream_diff import (
    Pin,
    TreeDiff,
    compare_trees,
    load_pin,
    render_report,
    tracked_downstream_paths,
    verify_git_archive_sha256,
)


class UpstreamDiffTests(unittest.TestCase):
    def test_classifies_exact_modified_only_deleted_and_symlink_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            upstream = root / "upstream"
            downstream = root / "apps" / "openterminal"
            upstream.mkdir(parents=True)
            downstream.mkdir(parents=True)

            (upstream / "same.ts").write_text("same\n", encoding="utf-8")
            (downstream / "same.ts").write_text("same\n", encoding="utf-8")
            (upstream / "changed.ts").write_text("upstream\n", encoding="utf-8")
            (downstream / "changed.ts").write_text("eqoboard\n", encoding="utf-8")
            (upstream / "deleted.ts").write_text("removed downstream\n", encoding="utf-8")
            (downstream / "only.ts").write_text("eqoboard extension\n", encoding="utf-8")
            (upstream / "executable.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (downstream / "executable.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (upstream / "executable.sh").chmod(0o755)
            (downstream / "executable.sh").chmod(0o644)

            (upstream / "link.ts").symlink_to("upstream-target.ts")
            (downstream / "link.ts").symlink_to("eqoboard-target.ts")

            diff = compare_trees(
                upstream,
                downstream,
                {"same.ts", "changed.ts", "link.ts", "only.ts", "deleted.ts", "executable.sh"},
            )

            self.assertEqual(diff.exact, ("same.ts",))
            self.assertEqual(diff.modified, ("changed.ts", "executable.sh", "link.ts"))
            self.assertEqual(diff.eqoboard_only, ("only.ts",))
            self.assertEqual(diff.deleted, ("deleted.ts",))

    def test_gitignored_untracked_files_are_not_reported_as_eqoboard_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "apps" / "openterminal").mkdir(parents=True)
            (root / ".gitignore").write_text("apps/openterminal/generated.log\n", encoding="utf-8")
            (root / "apps" / "openterminal" / "kept.ts").write_text("tracked\n", encoding="utf-8")
            (root / "apps" / "openterminal" / "generated.log").write_text("ignored\n", encoding="utf-8")
            (root / "apps" / "openterminal" / "ignored-link").symlink_to("kept.ts")
            (root / "apps" / "openterminal" / "generated-link").symlink_to("generated.log")
            import subprocess

            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", ".gitignore", "apps/openterminal/kept.ts", "apps/openterminal/ignored-link"], check=True)

            tracked = tracked_downstream_paths(root, "apps/openterminal")

            self.assertEqual(tracked, {"kept.ts", "ignored-link"})

    def test_report_records_pin_archive_hash_and_all_four_diff_classes(self):
        pin = Pin("ErTasselli/OpenTerminal", "a" * 40, "MIT", "apps/openterminal")
        diff = TreeDiff(("same.ts",), ("changed.ts",), ("extension.tsx",), ("deleted.ts",))

        report = render_report(diff, pin, "b" * 40, "2026-10-07 00:00:00 UTC", "c" * 64)

        self.assertIn("OpenTerminal upstream commit: `" + "a" * 40 + "`", report)
        self.assertIn("Verified Git archive SHA-256: `" + "c" * 64 + "`", report)
        self.assertIn("A · exact upstream files: 1", report)
        self.assertIn("B · modified upstream files: 1", report)
        self.assertIn("C/E · EqoBoard-only files: 1", report)
        self.assertIn("Deleted upstream files: 1", report)
        self.assertIn("待人工审核", report)

    def test_lock_rejects_repository_urls_and_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "upstreams.lock.json"
            for repository, prefix in (("https://github.com/Evil/OpenTerminal", "apps/openterminal"),
                                       ("ErTasselli/OpenTerminal", "../../outside")):
                lock.write_text(json.dumps({"sources": [{
                    "name": "OpenTerminal",
                    "repository": repository,
                    "commit": "a" * 40,
                    "license": "MIT",
                    "downstream_prefix": prefix,
                }]}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_pin(lock)

    def test_lock_archive_hash_uses_git_archive_field(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "upstreams.lock.json"
            lock.write_text(json.dumps({"sources": [{
                "name": "OpenTerminal",
                "repository": "ErTasselli/OpenTerminal",
                "commit": "a" * 40,
                "license": "MIT",
                "downstream_prefix": "apps/openterminal",
                "git_archive_sha256": "b" * 64,
            }]}), encoding="utf-8")

            pin = load_pin(lock)
            self.assertEqual(pin.expected_git_archive_sha256, "b" * 64)
            with self.assertRaises(RuntimeError):
                verify_git_archive_sha256(pin, "c" * 64)


if __name__ == "__main__":
    unittest.main()
