"""Offline checks for the pinned OpenBB source and build safety gate."""

import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "openbb" / "openbb_upstream.py"
SPEC = importlib.util.spec_from_file_location("openbb_upstream", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
upstream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream)


class OpenBBSourceSupplyChainTests(unittest.TestCase):
    def test_source_lock_pins_archive_and_license_material(self):
        entry = upstream.openbb_entry()
        self.assertEqual(entry["commit"], upstream.EXPECTED_COMMIT)
        self.assertEqual(entry["source_archive"]["sha256"], upstream.EXPECTED_ARCHIVE_SHA256)
        self.assertEqual(len(entry["license_files"]), 2)
        for item in entry["license_files"]:
            local = ROOT / item["local_path"]
            self.assertTrue(local.is_file())
            self.assertEqual(upstream.sha256_file(local), item["sha256"])

    def test_syft_toolchain_is_exact_and_platform_hashes_are_present(self):
        syft = upstream.toolchain()
        self.assertEqual(syft["version"], "1.54.1")
        self.assertEqual(
            set(syft["archives"]),
            {"linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64"},
        )
        for record in syft["archives"].values():
            self.assertRegex(record["sha256"], r"^[0-9a-f]{64}$")

    def test_safe_extractor_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / "bad.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                member = tarfile.TarInfo(
                    f"workspace-{upstream.EXPECTED_COMMIT}/../../escaped.txt"
                )
                payload = b"outside"
                member.size = len(payload)
                bundle.addfile(member, io.BytesIO(payload))
            with self.assertRaises(upstream.SupplyChainError):
                upstream.safe_extract(archive, pathlib.Path(directory) / "source")
            self.assertFalse((pathlib.Path(directory) / "escaped.txt").exists())

    def test_source_verifier_rejects_archive_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / "tampered.tar.gz"
            archive.write_bytes(b"not the pinned source archive")
            with self.assertRaisesRegex(upstream.SupplyChainError, "SHA-256 mismatch"):
                upstream.verify_archive(archive)

    def test_inspector_flags_unlicensed_and_unreproducible_source_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory)
            terminal = source / "terminalpro"
            (terminal / "src").mkdir(parents=True)
            (source / "lite").mkdir()
            (terminal / "package.json").write_text(
                json.dumps({
                    "dependencies": {
                        "ag-grid-enterprise": "34.1.1",
                        "ag-charts-enterprise": "12.1.1",
                        "highcharts": "^11.4.8",
                    }
                }),
                encoding="utf-8",
            )
            (terminal / "bun.lock").write_text("locked", encoding="utf-8")
            (terminal / "src" / "main.tsx").write_text(
                "LicenseManager.setLicenseKey(\"redacted\");", encoding="utf-8"
            )
            (source / "lite" / "Dockerfile").write_text(
                "\n".join([
                    "FROM node:22 AS frontend-build",
                    "COPY terminalpro/package-lock.json ./",
                    "RUN npm ci",
                    "FROM python:3.13-slim AS backend-build",
                    "RUN poetry lock --no-update || poetry lock",
                ]),
                encoding="utf-8",
            )
            finding_ids = {finding["id"] for finding in upstream.inspect_build_blockers(source)}
            self.assertTrue({
                "commercial-grid-and-chart-packages",
                "commercial-enterprise-code-remains",
                "embedded-openbb-pro-enterprise-key",
                "highcharts-commercial-license",
                "upstream-dockerfile-lockfile-mismatch",
                "upstream-poetry-lock-fallback",
                "mutable-container-base-images",
                "license-notice-not-copied-into-image",
            }.issubset(finding_ids))
            lock_findings = set(upstream.openbb_entry()["build_gate"]["required_findings_to_clear"])
            self.assertTrue(finding_ids.issubset(lock_findings))

    def test_inspector_accepts_a_pinned_community_recipe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            terminal = root / "terminalpro"
            (terminal / "src").mkdir(parents=True)
            (terminal / "package.json").write_text(
                json.dumps({
                    "dependencies": {
                        "ag-grid-community": "34.1.1",
                        "ag-charts-community": "12.1.1",
                    }
                }),
                encoding="utf-8",
            )
            (terminal / "bun.lock").write_text("locked", encoding="utf-8")
            (terminal / "src" / "main.tsx").write_text("community modules only", encoding="utf-8")
            recipe = root / "OpenBB.Lite.Dockerfile"
            digest = "a" * 64
            recipe.write_text(
                "\n".join([
                    f"FROM node:22.23.3-bookworm-slim@sha256:{digest} AS frontend",
                    "RUN bun install --frozen-lockfile",
                    f"FROM python:3.13-slim@sha256:{digest} AS backend",
                    "RUN poetry install --only main --sync",
                    "FROM frontend AS runtime",
                "COPY licenses/OPENBB-LICENSE /usr/share/licenses/openbb/LICENSE",
                "COPY licenses/OPENBB-NOTICE /usr/share/licenses/openbb/NOTICE",
                f"COPY source/workspace-{upstream.EXPECTED_COMMIT}.tar.gz /tmp/workspace-{upstream.EXPECTED_COMMIT}.tar.gz",
                f"RUN echo '4171aa8984c7c63e171239f8cda72c4bc950f1e068de33577035dc8e5d63e6a4  /tmp/workspace-{upstream.EXPECTED_COMMIT}.tar.gz' | sha256sum -c -",
                ]),
                encoding="utf-8",
            )
            self.assertEqual(upstream.inspect_build_blockers(root, recipe), [])

    def test_unrelated_hash_text_and_sha_check_do_not_clear_archive_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "terminalpro" / "src").mkdir(parents=True)
            (root / "terminalpro" / "package.json").write_text(
                json.dumps({"dependencies": {"ag-grid-community": "34.1.1", "ag-charts-community": "12.1.1"}}),
                encoding="utf-8",
            )
            (root / "terminalpro" / "bun.lock").write_text("locked", encoding="utf-8")
            (root / "terminalpro" / "src" / "main.tsx").write_text("community only", encoding="utf-8")
            recipe = root / "Dockerfile"
            recipe.write_text(
                "\n".join([
                    "FROM node:22@sha256:" + "a" * 64,
                    f"COPY source/workspace-{upstream.EXPECTED_COMMIT}.tar.gz /tmp/source.tar.gz",
                    f"RUN echo {upstream.EXPECTED_ARCHIVE_SHA256} > /tmp/not-source.sha256",
                    "RUN sha256sum -c /tmp/unrelated.sha256",
                    f"RUN true # echo '{upstream.EXPECTED_ARCHIVE_SHA256}  /tmp/source.tar.gz' | sha256sum -c -",
                    "COPY licenses/LICENSE /licenses/LICENSE",
                    "COPY licenses/NOTICE /licenses/NOTICE",
                ]),
                encoding="utf-8",
            )
            findings = {item["id"] for item in upstream.inspect_build_blockers(root, recipe)}
            self.assertIn("source-archive-not-verified-in-image-build", findings)

            recipe.write_text(
                "\n".join([
                    "FROM node:22@sha256:" + "a" * 64,
                    f"COPY source/workspace-{upstream.EXPECTED_COMMIT}.tar.gz /tmp/source.tar.gz",
                    'SHELL ["/bin/true", "-c"]',
                    f"RUN echo '{upstream.EXPECTED_ARCHIVE_SHA256}  /tmp/source.tar.gz' | sha256sum -c -",
                    "COPY licenses/LICENSE /licenses/LICENSE",
                    "COPY licenses/NOTICE /licenses/NOTICE",
                ]),
                encoding="utf-8",
            )
            findings = {item["id"] for item in upstream.inspect_build_blockers(root, recipe)}
            self.assertIn("source-archive-not-verified-in-image-build", findings)

    def test_lite_build_fails_before_network_or_docker_without_approval(self):
        entry = {
            "build_gate": {
                "status": "blocked",
                "required_findings_to_clear": ["fixture-review-blocker"],
            }
        }
        output = io.StringIO()
        with (
            mock.patch.object(upstream, "openbb_entry", return_value=entry),
            mock.patch.object(upstream, "fetch_archive", side_effect=AssertionError("unexpected network")),
            mock.patch.object(upstream.subprocess, "run", side_effect=AssertionError("unexpected command")),
            redirect_stderr(output),
        ):
            with self.assertRaises(SystemExit) as raised:
                upstream.build_lite(None, None)
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("build gate", output.getvalue().lower())
        self.assertIn("fixture-review-blocker", output.getvalue())

    def test_syft_cache_is_replaced_from_the_verified_release_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive = root / "syft.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                member = tarfile.TarInfo("syft")
                payload = b"trusted-syft-binary"
                member.size = len(payload)
                bundle.addfile(member, io.BytesIO(payload))
            digest = upstream.sha256_file(archive)
            cached = root / "cache" / "syft"
            cached.parent.mkdir()
            outside = root / "malicious-binary"
            outside.write_bytes(b"attacker-controlled-executable")
            cached.symlink_to(outside)
            upstream.install_verified_executable(archive, digest, cached)
            self.assertEqual(cached.read_bytes(), b"trusted-syft-binary")
            self.assertFalse(cached.is_symlink())
            self.assertTrue(cached.stat().st_mode & 0o111)

    def test_syft_cache_refuses_an_unverified_release_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive = root / "syft.tar.gz"
            archive.write_bytes(b"tampered")
            with self.assertRaisesRegex(upstream.SupplyChainError, "archive digest changed"):
                upstream.install_verified_executable(archive, "0" * 64, root / "cache" / "syft")

    def test_license_inventory_rejects_traversal_and_symlink_paths(self):
        entry = upstream.openbb_entry()
        malicious = [dict(item) for item in entry["license_files"]]
        malicious[0]["upstream_path"] = "../../etc/passwd"
        with self.assertRaises(upstream.SupplyChainError):
            upstream.validate_license_records(malicious)

        with tempfile.TemporaryDirectory() as directory:
            fake_root = pathlib.Path(directory) / "repo"
            license_dir = fake_root / "third_party" / "licenses" / "openbb-workspace"
            license_dir.mkdir(parents=True)
            outside = pathlib.Path(directory) / "outside"
            outside.write_text("not the upstream license", encoding="utf-8")
            (license_dir / "LICENSE").symlink_to(outside)
            (license_dir / "NOTICE").write_text("notice", encoding="utf-8")
            with mock.patch.object(upstream, "ROOT", fake_root):
                with self.assertRaisesRegex(upstream.SupplyChainError, "symlink"):
                    upstream.validate_license_records(entry["license_files"])

    def test_build_tag_is_bound_to_the_reviewed_build_identity(self):
        identity = "a" * 64
        upstream.validate_immutable_tag(
            f"eqoboard/openbb-workspace:{upstream.EXPECTED_COMMIT}-{identity[:16]}", identity
        )
        with self.assertRaisesRegex(upstream.SupplyChainError, "content-specific"):
            upstream.validate_immutable_tag("eqoboard/openbb-workspace:latest", identity)
        with self.assertRaisesRegex(upstream.SupplyChainError, "must end"):
            upstream.validate_immutable_tag("eqoboard/openbb-workspace:custom", identity)

    def test_existing_image_tag_with_different_provenance_is_rejected(self):
        result = mock.Mock(returncode=0, stdout='{"org.eqoboard.openbb.build.identity":"other"}')
        with mock.patch.object(upstream.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(upstream.SupplyChainError, "refusing to overwrite"):
                upstream.ensure_image_tag_available("eqoboard/openbb-workspace:tag", "a" * 64)

    def test_existing_image_label_cannot_authorize_skipping_the_build(self):
        identity = "a" * 64
        result = mock.Mock(
            returncode=0,
            stdout=json.dumps({"org.eqoboard.openbb.build.identity": identity}),
        )
        with mock.patch.object(upstream.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(upstream.SupplyChainError, "refusing to rebuild"):
                upstream.ensure_image_tag_available("eqoboard/openbb-workspace:tag", identity)

    def test_build_support_file_hashes_are_checked_before_context_assembly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            asset = root / "tools" / "openbb" / "community" / "patch.diff"
            asset.parent.mkdir(parents=True)
            asset.write_bytes(b"pinned patch")
            record = {"path": "tools/openbb/community/patch.diff", "sha256": upstream.sha256_file(asset)}
            with mock.patch.object(upstream, "ROOT", root):
                self.assertEqual(
                    upstream.validate_recipe_assets({"support_files": [record]}),
                    [(record["path"], asset, record["sha256"])],
                )
                asset.write_bytes(b"modified patch")
                with self.assertRaisesRegex(upstream.SupplyChainError, "SHA-256 does not match"):
                    upstream.validate_recipe_assets({"support_files": [record]})


if __name__ == "__main__":
    unittest.main()
