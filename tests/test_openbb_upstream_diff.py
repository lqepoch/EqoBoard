"""Tests for the pinned OpenBB source-to-adapter drift report."""

import importlib.util
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "openbb" / "openbb_upstream.py"
SPEC = importlib.util.spec_from_file_location("openbb_upstream_diff", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
upstream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream)


class OpenBBUpstreamDiffTests(unittest.TestCase):
    def test_file_comparison_reports_exact_modified_added_deleted_and_mode_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            original = root / "original"
            patched = root / "patched"
            original.mkdir()
            patched.mkdir()
            (original / "same.txt").write_text("same", encoding="utf-8")
            (patched / "same.txt").write_text("same", encoding="utf-8")
            (original / "modified.txt").write_text("before", encoding="utf-8")
            (patched / "modified.txt").write_text("after", encoding="utf-8")
            (original / "mode.txt").write_text("same content", encoding="utf-8")
            (patched / "mode.txt").write_text("same content", encoding="utf-8")
            (original / "mode.txt").chmod(0o644)
            (patched / "mode.txt").chmod(0o755)
            (original / "deleted.txt").write_text("removed", encoding="utf-8")
            (patched / "added.txt").write_text("new", encoding="utf-8")

            result = upstream.compare_source_trees(original, patched)

            self.assertEqual(result["counts"], {
                "exact_upstream_files": 1,
                "modified_upstream_files": 2,
                "eqoboard_only_files": 1,
                "deleted_upstream_files": 1,
                "upstream_files": 4,
                "patched_files": 4,
            })
            self.assertEqual(
                {item["path"]: item["classification"] for item in result["files"]},
                {
                    "added.txt": "eqoboard-only",
                    "deleted.txt": "deleted-upstream",
                    "mode.txt": "modified-upstream",
                    "modified.txt": "modified-upstream",
                    "same.txt": "exact-upstream",
                },
            )
            self.assertEqual(len(result["upstream_tree_sha256"]), 64)
            self.assertEqual(len(result["patched_tree_sha256"]), 64)

    def test_file_inventory_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            outside = root / "outside.txt"
            outside.write_text("outside", encoding="utf-8")
            source = root / "source"
            source.mkdir()
            (source / "linked.txt").symlink_to(outside)
            with self.assertRaisesRegex(upstream.SupplyChainError, "symlink"):
                upstream.inventory_source_tree(source)

    def test_pinned_patch_report_is_written_from_verified_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            assets = root / "tools" / "openbb" / "community"
            assets.mkdir(parents=True)
            dockerfile = assets / "Dockerfile"
            dockerfile.write_text("FROM pinned/base@sha256:fixture\n", encoding="utf-8")
            patch_file = assets / "community.patch"
            patch_file.write_text("pinned patch bytes\n", encoding="utf-8")
            manifest = assets / "community.patch.json"
            manifest.write_text("{}\n", encoding="utf-8")
            runner = assets / "apply_patch.py"
            runner.write_text(
                "\n".join([
                    "import argparse",
                    "from pathlib import Path",
                    "parser = argparse.ArgumentParser()",
                    "parser.add_argument('--source', required=True)",
                    "parser.add_argument('--patch', action='append', required=True)",
                    "args = parser.parse_args()",
                    "source = Path(args.source)",
                    f"assert source.name == 'workspace-{upstream.EXPECTED_COMMIT}'",
                    "assert all(Path(path).is_file() for path in args.patch)",
                    "(source / 'modified.txt').write_text('patched', encoding='utf-8')",
                    "(source / 'deleted.txt').unlink()",
                    "(source / 'eqo.txt').write_text('extension', encoding='utf-8')",
                ]) + "\n",
                encoding="utf-8",
            )
            support = [
                {"path": path.relative_to(root).as_posix(), "sha256": upstream.sha256_file(path)}
                for path in (dockerfile, runner, patch_file, manifest)
            ]
            archive = root / "workspace.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                for name, payload in {
                    "same.txt": b"same",
                    "modified.txt": b"original",
                    "deleted.txt": b"gone",
                }.items():
                    member = tarfile.TarInfo(f"workspace-{upstream.EXPECTED_COMMIT}/{name}")
                    member.mode = 0o644
                    member.size = len(payload)
                    bundle.addfile(member, io.BytesIO(payload))
            recipe = {
                "path": dockerfile.relative_to(root).as_posix(),
                "sha256": upstream.sha256_file(dockerfile),
                "variant": "lite-community",
                "support_files": support,
                "source_patch": {
                    "runner": support[1],
                    "files": [support[2]],
                },
            }
            entry = {"build_recipe": recipe}
            output = root / "build" / "openbb" / "drift.json"
            outside = root / "outside.json"
            outside.write_text("preserve", encoding="utf-8")
            output.parent.mkdir(parents=True)
            output.symlink_to(outside)

            with (
                mock.patch.object(upstream, "ROOT", root),
                mock.patch.object(upstream, "openbb_entry", return_value=entry),
                mock.patch.object(upstream, "verify_archive", return_value={
                    "repository": upstream.EXPECTED_REPOSITORY,
                    "commit": upstream.EXPECTED_COMMIT,
                    "archive_sha256": upstream.EXPECTED_ARCHIVE_SHA256,
                }),
            ):
                report = upstream.openbb_upstream_diff(archive, output)

            self.assertFalse(output.is_symlink())
            self.assertEqual(outside.read_text(encoding="utf-8"), "preserve")
            self.assertEqual(report["counts"]["exact_upstream_files"], 1)
            self.assertEqual(report["counts"]["modified_upstream_files"], 1)
            self.assertEqual(report["counts"]["eqoboard_only_files"], 1)
            self.assertEqual(report["counts"]["deleted_upstream_files"], 1)
            self.assertEqual(report["source_patch"]["runner"]["path"], support[1]["path"])
            self.assertEqual(
                {item["path"] for item in report["support_files"]},
                {item["path"] for item in support},
            )
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(saved["kind"], "openbb-upstream-diff")
            self.assertNotIn("output", saved)

    def test_lite_build_passes_the_pinned_source_root_name_to_patch_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            community = root / "tools" / "openbb" / "community"
            community.mkdir(parents=True)
            recipe_path = community / "Dockerfile"
            recipe_path.write_text("FROM fixture@sha256:pinned\n", encoding="utf-8")
            patch_path = community / "community.patch"
            patch_path.write_text("pinned patch\n", encoding="utf-8")
            runner_path = community / "apply_patch.py"
            runner_path.write_text(
                "\n".join([
                    "import argparse",
                    "from pathlib import Path",
                    "parser = argparse.ArgumentParser()",
                    "parser.add_argument('--source', required=True)",
                    "parser.add_argument('--patch', action='append', required=True)",
                    "args = parser.parse_args()",
                    f"assert Path(args.source).name == 'workspace-{upstream.EXPECTED_COMMIT}'",
                    "assert all(Path(path).is_file() for path in args.patch)",
                ]) + "\n",
                encoding="utf-8",
            )
            support = [
                {"path": path.relative_to(root).as_posix(), "sha256": upstream.sha256_file(path)}
                for path in (recipe_path, runner_path, patch_path)
            ]
            recipe = {
                "path": support[0]["path"],
                "sha256": support[0]["sha256"],
                "variant": "lite-community",
                "support_files": support,
                "source_patch": {"runner": support[1], "files": [support[2]]},
            }
            entry = {
                "build_gate": {
                    "status": "local-buildable",
                    "required_findings_to_clear": [],
                    "runtime_acceptance": "not-verified",
                    "browser_e2e": "not-run",
                    "deployment": "not-approved",
                    "evidence": None,
                },
                "build_recipe": recipe,
                "license_files": [],
            }
            archive = root / "workspace.tar.gz"
            archive.write_bytes(b"test archive")
            real_subprocess_run = upstream.subprocess.run
            commands = []

            def run(command, **kwargs):
                if command[0] == sys.executable:
                    return real_subprocess_run(command, **kwargs)
                commands.append(command)
                if command[:2] == ["docker", "image"]:
                    return mock.Mock(returncode=0, stdout="sha256:fixture-image\n")
                return mock.Mock(returncode=0, stdout="", stderr="")

            def extract(_archive, destination):
                self.assertEqual(destination.name, f"workspace-{upstream.EXPECTED_COMMIT}")
                (destination / "lite").mkdir(parents=True)
                (destination / "terminalpro").mkdir()
                (destination / "backend-api" / "backend").mkdir(parents=True)

            def scan(_syft, _source, output, *_args, **_kwargs):
                output.write_text(
                    json.dumps({"spdxVersion": "SPDX-2.3", "packages": [{"name": "fixture", "versionInfo": "1"}]}),
                    encoding="utf-8",
                )
                return {"spdxVersion": "SPDX-2.3", "packages": [{"name": "fixture", "versionInfo": "1"}]}

            with (
                mock.patch.object(upstream, "ROOT", root),
                mock.patch.object(upstream, "openbb_entry", return_value=entry),
                mock.patch.object(upstream, "verify_archive", return_value={
                    "archive_sha256": upstream.EXPECTED_ARCHIVE_SHA256,
                }),
                mock.patch.object(upstream, "safe_extract", side_effect=extract),
                mock.patch.object(upstream, "inspect_build_blockers", return_value=[]),
                mock.patch.object(upstream, "ensure_image_tag_available"),
                mock.patch.object(upstream, "syft_binary", return_value=(root / "syft", "1.54.1")),
                mock.patch.object(upstream, "stable_sbom_scan", side_effect=scan),
                mock.patch.object(upstream.subprocess, "run", side_effect=run),
            ):
                with redirect_stdout(io.StringIO()):
                    upstream.build_lite(None, archive)

            self.assertEqual(len([item for item in commands if item[:2] == ["docker", "buildx"]]), 1)
            build_records = list((root / "build" / "openbb").glob("*.build.json"))
            self.assertEqual(len(build_records), 1)
            self.assertEqual(json.loads(build_records[0].read_text(encoding="utf-8"))["local_image_id"], "sha256:fixture-image")


if __name__ == "__main__":
    unittest.main()
