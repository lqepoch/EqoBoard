"""Tests for the pinned OpenBB source-to-adapter drift report."""

import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import time
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
    def test_build_lock_serializes_processes_sharing_an_immutable_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            first_worktree = root / "worktree-one"
            second_worktree = root / "worktree-two"
            first_worktree.mkdir()
            second_worktree.mkdir()
            shared_cache = root / "shared-cache"
            first_started = root / "first.started"
            first_entered = root / "first.entered"
            second_started = root / "second.started"
            second_entered = root / "second.entered"
            release_first = root / "release-first"
            worker = """
import importlib.util
import pathlib
import sys
import time
spec = importlib.util.spec_from_file_location('openbb_lock_test', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ROOT = pathlib.Path(sys.argv[2])
pathlib.Path(sys.argv[6]).touch()
with module.image_build_lock(sys.argv[3], sys.argv[4]):
    pathlib.Path(sys.argv[7]).touch()
    if sys.argv[5] != '-':
        release = pathlib.Path(sys.argv[5])
        while not release.exists():
            time.sleep(0.01)
"""
            shared_tag = f"eqoboard/openbb-workspace:{'a' * 16}"
            first_identity = "a" * 16 + "1" * 48
            second_identity = "a" * 16 + "2" * 48

            def start(identity, worktree, started, entered, release):
                return subprocess.Popen([
                    sys.executable,
                    "-c",
                    worker,
                    str(MODULE_PATH),
                    str(worktree),
                    identity,
                    shared_tag,
                    str(release) if release else "-",
                    str(started),
                    str(entered),
                ], env=dict(os.environ, XDG_CACHE_HOME=str(shared_cache)))

            first = start(first_identity, first_worktree, first_started, first_entered, release_first)
            second = None
            try:
                deadline = time.monotonic() + 5
                while not first_entered.exists() and time.monotonic() < deadline:
                    if first.poll() is not None:
                        self.fail(f"first lock worker exited early with {first.returncode}")
                    time.sleep(0.01)
                self.assertTrue(first_entered.exists(), "first lock worker did not acquire the tag lock")
                second = start(second_identity, second_worktree, second_started, second_entered, None)
                deadline = time.monotonic() + 5
                while not second_started.exists() and time.monotonic() < deadline:
                    if second.poll() is not None:
                        self.fail(f"second lock worker exited early with {second.returncode}")
                    time.sleep(0.01)
                self.assertTrue(second_started.exists(), "second lock worker did not start")
                self.assertFalse(second_entered.exists(), "concurrent process entered a tag already being built")
                release_first.touch()
                self.assertEqual(first.wait(timeout=5), 0)
                deadline = time.monotonic() + 5
                while not second_entered.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(second_entered.exists(), "second lock worker did not acquire released tag lock")
                self.assertEqual(second.wait(timeout=5), 0)
            finally:
                if first.poll() is None:
                    first.terminate()
                    first.wait(timeout=5)
                if second is not None and second.poll() is None:
                    second.terminate()
                    second.wait(timeout=5)

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
            dockerfile.write_text(
                "\n".join([
                    "FROM pinned/base@sha256:fixture",
                    "COPY tools/openbb/community/apply_patch.py /opt/openbb-community/apply_patch.py",
                    "COPY tools/openbb/community/patches/community.patch /opt/openbb-community/community.patch",
                    "COPY tools/openbb/community/patches/community.patch.json /opt/openbb-community/community.patch.json",
                    "RUN python /opt/openbb-community/apply_patch.py \\",
                    f"    --source /opt/workspace-{upstream.EXPECTED_COMMIT} \\",
                    "    --patch /opt/openbb-community/community.patch",
                ]) + "\n",
                encoding="utf-8",
            )
            patch_directory = assets / "patches"
            patch_directory.mkdir()
            patch_file = patch_directory / "community.patch"
            patch_file.write_text("pinned patch bytes\n", encoding="utf-8")
            manifest = patch_directory / "community.patch.json"
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
            patch_directory = community / "patches"
            patch_directory.mkdir()
            recipe_path.write_text(
                "\n".join([
                    "FROM fixture@sha256:pinned",
                    "COPY tools/openbb/community/apply_patch.py /opt/openbb-community/apply_patch.py",
                    "COPY tools/openbb/community/patches/community.patch /opt/openbb-community/community.patch",
                    "COPY tools/openbb/community/patches/community.patch.json /opt/openbb-community/community.patch.json",
                    "RUN python /opt/openbb-community/apply_patch.py \\",
                    f"    --source /opt/workspace-{upstream.EXPECTED_COMMIT} \\",
                    "    --patch /opt/openbb-community/community.patch",
                ]) + "\n",
                encoding="utf-8",
            )
            patch_path = patch_directory / "community.patch"
            patch_path.write_text("pinned patch\n", encoding="utf-8")
            manifest_path = patch_directory / "community.patch.json"
            manifest_path.write_text("{}\n", encoding="utf-8")
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
                for path in (recipe_path, runner_path, patch_path, manifest_path)
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
            lock_root = root / "cache" / "eqoboard" / "openbb" / "build-locks"
            lock_root.mkdir(parents=True, mode=0o700)
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
                mock.patch.object(upstream, "local_build_lock_root", return_value=lock_root),
                mock.patch.object(upstream, "syft_binary", return_value=(root / "syft", "1.54.1")),
                mock.patch.object(upstream, "stable_sbom_scan", side_effect=scan),
                mock.patch.object(upstream.subprocess, "run", side_effect=run),
            ):
                with redirect_stdout(io.StringIO()):
                    upstream.build_lite(None, archive)
                self.assertEqual(len([item for item in commands if item[:2] == ["docker", "buildx"]]), 1)
                build_records = list((root / "build" / "openbb").glob("*.build.json"))
                self.assertEqual(len(build_records), 1)
                build_record = json.loads(build_records[0].read_text(encoding="utf-8"))
                self.assertEqual(build_record["local_image_id"], "sha256:fixture-image")
                self.assertIn(build_record["build_identity"], build_records[0].name)
                self.assertRegex(build_record["build_identity"], r"^[0-9a-f]{64}$")

                commands.clear()
                with redirect_stdout(io.StringIO()), self.assertRaisesRegex(
                    upstream.SupplyChainError, "existing OpenBB build record"
                ):
                    upstream.build_lite(None, archive)
                self.assertEqual(commands, [])


if __name__ == "__main__":
    unittest.main()
