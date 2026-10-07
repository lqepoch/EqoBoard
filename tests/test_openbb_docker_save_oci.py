#!/usr/bin/env python3
"""Fault-injection tests for OCI descriptor identity checks."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "openbb"))
from verify_docker_save_oci import verify_archive


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def descriptor(media_type: str, data: bytes, *, size: int | None = None) -> dict[str, Any]:
    return {"mediaType": media_type, "digest": digest(data), "size": len(data) if size is None else size}


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def make_archive(
    path: Path,
    inspect_path: Path,
    *,
    bad_repo_digest: str | None = None,
    duplicate_bad_size: bool = False,
    platform_claim: tuple[str, str] | None = ("linux", "amd64"),
    include_unknown_attestation: bool = False,
    direct_root_manifest: bool = False,
    inspect_config_id: bool = False,
    empty_repo_digests: bool = False,
    index_platform_claim: tuple[str, str] | None = None,
) -> str:
    image_tag = "eqoboard/openbb-workspace-lite:test"
    config = b'{"architecture":"amd64","os":"linux"}'
    layer = b"test layer archive"
    manifest = json_bytes({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": descriptor("application/vnd.oci.image.config.v1+json", config),
        "layers": [descriptor("application/vnd.oci.image.layer.v1.tar", layer)],
    })
    app_descriptor = descriptor("application/vnd.oci.image.manifest.v1+json", manifest)
    if platform_claim is not None:
        app_descriptor["platform"] = {"os": platform_claim[0], "architecture": platform_claim[1]}
    image_descriptors = [app_descriptor]
    extra_blobs: dict[str, bytes] = {}
    if include_unknown_attestation:
        empty_config = b"{}"
        attestation_layer = b"attestation fixture"
        attestation_manifest = json_bytes({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": descriptor("application/vnd.oci.empty.v1+json", empty_config),
            "layers": [descriptor("application/vnd.in-toto+json", attestation_layer)],
        })
        attestation_descriptor = descriptor("application/vnd.oci.image.manifest.v1+json", attestation_manifest)
        attestation_descriptor["platform"] = {"os": "unknown", "architecture": "unknown"}
        image_descriptors.append(attestation_descriptor)
        extra_blobs = {
            "blobs/sha256/" + digest(attestation_manifest).removeprefix("sha256:"): attestation_manifest,
            "blobs/sha256/" + digest(empty_config).removeprefix("sha256:"): empty_config,
            "blobs/sha256/" + digest(attestation_layer).removeprefix("sha256:"): attestation_layer,
        }
    if direct_root_manifest:
        root_descriptors = list(image_descriptors)
        if duplicate_bad_size:
            wrong = dict(app_descriptor)
            wrong["size"] += 1
            root_descriptors.append(wrong)
        root_index = json_bytes({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": root_descriptors,
        })
        image_index_descriptor = descriptor("application/vnd.oci.image.index.v1+json", root_index)
    else:
        image_index_value = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": image_descriptors,
        }
        if duplicate_bad_size:
            wrong = dict(app_descriptor)
            wrong["size"] += 1
            image_index_value["manifests"].append(wrong)
        image_index = json_bytes(image_index_value)
        image_index_descriptor = descriptor("application/vnd.oci.image.index.v1+json", image_index)
        if index_platform_claim is not None:
            image_index_descriptor["platform"] = {
                "os": index_platform_claim[0],
                "architecture": index_platform_claim[1],
            }
        root_index = json_bytes({"schemaVersion": 2, "manifests": [image_index_descriptor]})

    repo_digest = bad_repo_digest or image_index_descriptor["digest"]
    repo_digests = [] if empty_repo_digests else [f"eqoboard/openbb-workspace-lite@{repo_digest}"]
    inspect = [{
        "Id": digest(config) if inspect_config_id else image_index_descriptor["digest"],
        "Os": "linux",
        "Architecture": "amd64",
        "RepoDigests": repo_digests,
    }]
    inspect_path.write_text(json.dumps(inspect), encoding="utf-8")

    files = {
        "manifest.json": json_bytes([{
            "Config": "config.json",
            "RepoTags": [image_tag],
            "Layers": ["layer.tar"],
        }]),
        "config.json": config,
        "layer.tar": layer,
        "oci-layout": json_bytes({"imageLayoutVersion": "1.0.0"}),
        "index.json": root_index,
        "blobs/sha256/" + digest(manifest).removeprefix("sha256:"): manifest,
        "blobs/sha256/" + digest(config).removeprefix("sha256:"): config,
        "blobs/sha256/" + digest(layer).removeprefix("sha256:"): layer,
        **extra_blobs,
    }
    if not direct_root_manifest:
        files["blobs/sha256/" + digest(image_index).removeprefix("sha256:")] = image_index
    with tarfile.open(path, "w") as archive:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return image_tag


class VerifyDockerSaveOciTests(unittest.TestCase):
    def verify_fixture(
        self,
        *,
        bad_repo_digest: str | None = None,
        duplicate_bad_size: bool = False,
        platform_claim: tuple[str, str] | None = ("linux", "amd64"),
        include_unknown_attestation: bool = False,
        direct_root_manifest: bool = False,
        inspect_config_id: bool = False,
        empty_repo_digests: bool = False,
        index_platform_claim: tuple[str, str] | None = None,
    ):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        archive_path = root / "image.tar"
        inspect_path = root / "inspect.json"
        image_tag = make_archive(
            archive_path,
            inspect_path,
            bad_repo_digest=bad_repo_digest,
            duplicate_bad_size=duplicate_bad_size,
            platform_claim=platform_claim,
            include_unknown_attestation=include_unknown_attestation,
            direct_root_manifest=direct_root_manifest,
            inspect_config_id=inspect_config_id,
            empty_repo_digests=empty_repo_digests,
            index_platform_claim=index_platform_claim,
        )
        return verify_archive(str(archive_path), image_tag, str(inspect_path))

    def test_links_repo_digest_to_target_index_and_manifest(self):
        evidence = self.verify_fixture()
        self.assertTrue(evidence["oci"]["docker_repo_digests_linked_to_target_image"])
        self.assertEqual(evidence["oci"]["image_index_digest"], evidence["docker_image_id"])
        self.assertEqual(evidence["oci"]["layer_count"], 1)

    def test_rejects_repo_digest_that_only_matches_a_layer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            layer_digest = digest(b"test layer archive")
            archive_path = root / "image.tar"
            inspect_path = root / "inspect.json"
            image_tag = make_archive(archive_path, inspect_path, bad_repo_digest=layer_digest)
            with self.assertRaisesRegex(ValueError, "RepoDigest does not identify"):
                verify_archive(str(archive_path), image_tag, str(inspect_path))

    def test_rejects_duplicate_descriptor_with_wrong_size(self):
        with self.assertRaisesRegex(ValueError, "OCI blob size mismatch"):
            self.verify_fixture(duplicate_bad_size=True)

    def test_infers_missing_descriptor_platform_from_verified_config_not_attestation(self):
        evidence = self.verify_fixture(platform_claim=None, include_unknown_attestation=True)
        self.assertEqual(evidence["oci"]["platform"], "linux/amd64")
        self.assertEqual(evidence["oci"]["layer_count"], 1)

    def test_rejects_descriptor_platform_that_conflicts_with_verified_config(self):
        with self.assertRaisesRegex(ValueError, "does not match Docker-save config"):
            self.verify_fixture(platform_claim=("linux", "arm64"))

    def test_rejects_unknown_platform_claim_on_target_manifest(self):
        with self.assertRaisesRegex(ValueError, "does not match Docker-save config"):
            self.verify_fixture(platform_claim=("unknown", "unknown"))

    def test_rejects_conflicting_platform_claims_in_target_index_chain(self):
        with self.assertRaisesRegex(ValueError, "conflicting platform claims"):
            self.verify_fixture(index_platform_claim=("linux", "arm64"))

    def test_infers_direct_root_manifest_platform_from_target_config_and_inspect(self):
        evidence = self.verify_fixture(
            platform_claim=None,
            direct_root_manifest=True,
            inspect_config_id=True,
            empty_repo_digests=True,
        )
        self.assertEqual(evidence["docker_image_id_relation"], "config")
        self.assertEqual(evidence["oci"]["platform"], "linux/amd64")
        self.assertEqual(evidence["oci"]["image_index_digest"], evidence["oci"]["layout_index_sha256"])


if __name__ == "__main__":
    unittest.main()
