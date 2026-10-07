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


def make_archive(path: Path, inspect_path: Path, *, bad_repo_digest: str | None = None, duplicate_bad_size: bool = False) -> str:
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
    app_descriptor["platform"] = {"os": "linux", "architecture": "amd64"}
    image_index_value = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [app_descriptor],
    }
    if duplicate_bad_size:
        wrong = dict(app_descriptor)
        wrong["size"] += 1
        image_index_value["manifests"].append(wrong)
    image_index = json_bytes(image_index_value)
    image_index_descriptor = descriptor("application/vnd.oci.image.index.v1+json", image_index)
    root_index = json_bytes({"schemaVersion": 2, "manifests": [image_index_descriptor]})

    repo_digest = bad_repo_digest or image_index_descriptor["digest"]
    inspect = [{
        "Id": image_index_descriptor["digest"],
        "Os": "linux",
        "Architecture": "amd64",
        "RepoDigests": [f"eqoboard/openbb-workspace-lite@{repo_digest}"],
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
        "blobs/sha256/" + digest(image_index).removeprefix("sha256:"): image_index,
        "blobs/sha256/" + digest(manifest).removeprefix("sha256:"): manifest,
        "blobs/sha256/" + digest(config).removeprefix("sha256:"): config,
        "blobs/sha256/" + digest(layer).removeprefix("sha256:"): layer,
    }
    with tarfile.open(path, "w") as archive:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return image_tag


class VerifyDockerSaveOciTests(unittest.TestCase):
    def verify_fixture(self, *, bad_repo_digest: str | None = None, duplicate_bad_size: bool = False):
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


if __name__ == "__main__":
    unittest.main()
