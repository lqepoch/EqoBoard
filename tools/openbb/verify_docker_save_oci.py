#!/usr/bin/env python3
"""Verify a Docker-save archive and link OCI descriptors to its image."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import tarfile
from typing import Any


_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def _digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _member_bytes(archive: tarfile.TarFile, path: str) -> bytes:
    member = archive.extractfile(path)
    if member is None:
        raise ValueError(f"archive points to a missing object: {path}")
    return member.read()


def _verify_descriptor(
    archive: tarfile.TarFile,
    descriptor: dict[str, Any],
    observed_sizes: dict[str, int],
    verified_digests: set[str],
    include_bytes: bool,
) -> bytes | None:
    digest = descriptor.get("digest", "")
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise ValueError(f"unsupported or missing OCI descriptor digest: {digest}")
    size = descriptor.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ValueError(f"invalid OCI descriptor size: {digest}")

    path = "blobs/sha256/" + digest.removeprefix("sha256:")
    actual_size = observed_sizes.get(digest)
    data: bytes | None = None
    if actual_size is None:
        data = _member_bytes(archive, path)
        if _digest(data) != digest:
            raise ValueError(f"OCI blob digest mismatch: {digest}")
        actual_size = len(data)
        observed_sizes[digest] = actual_size
    elif include_bytes:
        data = _member_bytes(archive, path)
    if actual_size != size:
        raise ValueError(f"OCI blob size mismatch: {digest}")
    verified_digests.add(digest)
    return data


def verify_archive(archive_path: str, image_tag: str, inspect_path: str) -> dict[str, Any]:
    with open(inspect_path, encoding="utf-8") as stream:
        inspect_rows = json.load(stream)
    if not isinstance(inspect_rows, list) or len(inspect_rows) != 1:
        raise ValueError("Docker image inspect must contain exactly one image")
    inspect = inspect_rows[0]
    image_id = inspect["Id"]
    platform = f'{inspect["Os"]}/{inspect["Architecture"]}'

    with tarfile.open(archive_path, "r") as archive:
        names = set(archive.getnames())
        docker_manifests = json.loads(_member_bytes(archive, "manifest.json"))
        matches = [item for item in docker_manifests if image_tag in (item.get("RepoTags") or [])]
        if len(matches) != 1:
            raise ValueError(f"expected one Docker-save manifest for {image_tag}, found {len(matches)}")
        docker_record = matches[0]
        config_bytes = _member_bytes(archive, docker_record["Config"])
        config_digest = _digest(config_bytes)
        docker_layers = []
        for layer_path in docker_record["Layers"]:
            layer_bytes = _member_bytes(archive, layer_path)
            docker_layers.append({"path": layer_path, "digest": _digest(layer_bytes), "size": len(layer_bytes)})

        image_id_relation = "config" if image_id == config_digest else "unresolved"
        oci_evidence = None
        if "index.json" in names:
            if "oci-layout" not in names:
                raise ValueError("OCI image layout is missing oci-layout")
            layout = json.loads(_member_bytes(archive, "oci-layout"))
            if layout.get("imageLayoutVersion") != "1.0.0":
                raise ValueError("unsupported OCI image layout version")
            root_index_bytes = _member_bytes(archive, "index.json")
            root_index = json.loads(root_index_bytes)
            root_index_digest = _digest(root_index_bytes)
            root_descriptors = root_index.get("manifests", [])
            if not isinstance(root_descriptors, list):
                raise ValueError("OCI root index manifests must be a list")

            observed_sizes: dict[str, int] = {}
            verified_digests: set[str] = set()
            expanded: set[tuple[str, str]] = set()
            app_manifests: list[dict[str, Any]] = []
            index_descriptors: list[dict[str, Any]] = []

            def visit_descriptor(descriptor: dict[str, Any], path: tuple[dict[str, Any], ...]) -> None:
                digest = descriptor.get("digest", "")
                media_type = descriptor.get("mediaType", "")
                # Validate every descriptor occurrence, including duplicates, before
                # using the expansion cache. A duplicate cannot smuggle a false size.
                blob = _verify_descriptor(
                    archive,
                    descriptor,
                    observed_sizes,
                    verified_digests,
                    include_bytes=(digest, media_type) not in expanded,
                )
                visit_key = (digest, media_type)
                if visit_key in expanded:
                    return
                expanded.add(visit_key)

                if media_type.endswith("image.index.v1+json"):
                    index_descriptors.append(descriptor)
                    nested = json.loads(blob or b"")
                    children = nested.get("manifests", [])
                    if not isinstance(children, list):
                        raise ValueError(f"OCI nested index manifests must be a list: {digest}")
                    for child in children:
                        visit_descriptor(child, path + (child,))
                    return

                if media_type.endswith("image.manifest.v1+json"):
                    manifest = json.loads(blob or b"")
                    config = manifest.get("config")
                    layers = manifest.get("layers", [])
                    if not isinstance(config, dict) or not isinstance(layers, list):
                        raise ValueError(f"OCI image manifest is missing config or layer descriptors: {digest}")
                    _verify_descriptor(archive, config, observed_sizes, verified_digests, include_bytes=False)
                    for layer in layers:
                        _verify_descriptor(archive, layer, observed_sizes, verified_digests, include_bytes=False)
                    platform_descriptor = next(
                        (item.get("platform") for item in reversed(path) if item.get("platform")),
                        {},
                    )
                    platform_value = f'{platform_descriptor.get("os", "")}/{platform_descriptor.get("architecture", "")}'
                    if platform_value == platform:
                        index_chain = [
                            item["digest"]
                            for item in path
                            if item.get("mediaType", "").endswith("image.index.v1+json")
                        ]
                        app_manifests.append({
                            "descriptor": descriptor,
                            "manifest": manifest,
                            "index_chain": index_chain,
                        })
                    return

                raise ValueError(f"unsupported OCI descriptor media type: {media_type}")

            for descriptor in root_descriptors:
                visit_descriptor(descriptor, (descriptor,))
            if len(app_manifests) != 1:
                raise ValueError(f"expected one OCI application manifest for {platform}, found {len(app_manifests)}")

            app = app_manifests[0]
            app_descriptor = app["descriptor"]
            app_manifest = app["manifest"]
            app_config = app_manifest["config"]
            app_layers = app_manifest["layers"]
            if app_config["digest"] != config_digest:
                raise ValueError("OCI application config does not match Docker-save config")
            if [item["digest"] for item in app_layers] != [item["digest"] for item in docker_layers]:
                raise ValueError("OCI application layers do not match Docker-save layers")

            release_descriptors = set(app["index_chain"]) | {app_descriptor["digest"], root_index_digest}
            if image_id == root_index_digest:
                image_id_relation = "oci-layout-index"
            elif image_id in app["index_chain"]:
                image_id_relation = "oci-image-index"
            elif image_id == app_descriptor["digest"]:
                image_id_relation = "oci-image-manifest"
            elif image_id != config_digest:
                raise ValueError("Docker image inspect ID is not linked to the target OCI image or config")

            repo_digests = inspect.get("RepoDigests") or []
            for reference in repo_digests:
                if not isinstance(reference, str) or "@" not in reference:
                    raise ValueError("Docker RepoDigest is not a repository@sha256 reference")
                repo_digest = reference.rsplit("@", 1)[1]
                if repo_digest not in release_descriptors:
                    raise ValueError("Docker RepoDigest does not identify the target OCI index or image manifest")

            target_indexes = app["index_chain"]
            observed_index = next((digest for digest in target_indexes if digest == image_id), None)
            if observed_index is None:
                observed_index = next(
                    (digest for digest in target_indexes if any(ref.endswith("@" + digest) for ref in repo_digests)),
                    None,
                )
            if observed_index is None and image_id == root_index_digest:
                observed_index = root_index_digest
            if observed_index is None and len(target_indexes) == 1:
                observed_index = target_indexes[0]

            oci_evidence = {
                "layout_index_sha256": root_index_digest,
                "docker_inspect_id_relation": image_id_relation,
                "image_index_digest": observed_index,
                "application_manifest_digest": app_descriptor["digest"],
                "application_manifest_size": app_descriptor["size"],
                "platform": platform,
                "config_digest": app_config["digest"],
                "config_size": app_config["size"],
                "layer_count": len(app_layers),
                "layers": app_layers,
                "unique_verified_oci_blob_digests": len(verified_digests),
                "docker_repo_digests_linked_to_target_image": True,
                "docker_save_manifest_matches_application_config_and_layers": True,
            }
        elif image_id != config_digest:
            raise ValueError("Docker image inspect ID is neither an OCI image descriptor nor Docker-save config")
        elif inspect.get("RepoDigests"):
            raise ValueError("Docker RepoDigest cannot be associated without an OCI image index")

    with open(archive_path, "rb") as stream:
        archive_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "format": "docker-save-archive",
        "image_tag": image_tag,
        "docker_image_id": image_id,
        "docker_image_id_relation": image_id_relation,
        "docker_repo_digests": inspect.get("RepoDigests") or [],
        "archive_sha256": archive_sha256,
        "archive_manifest_file": "manifest.json",
        "docker_manifest_record": docker_record,
        "platform": platform,
        "image_config_sha256": config_digest,
        "image_config_matches_docker_inspect_id": image_id == config_digest,
        "layer_archives": docker_layers,
        "oci": oci_evidence,
        "note": (
            "OCI descriptors are included only after digest/size validation and association with the "
            "Docker-save config/layers. A daemon RepoDigest observation does not imply registry publication."
        ),
    }


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: verify_docker_save_oci.py ARCHIVE IMAGE_TAG INSPECT_JSON OUTPUT_JSON", file=sys.stderr)
        return 2
    archive_path, image_tag, inspect_path, output_path = argv
    try:
        evidence = verify_archive(archive_path, image_tag, inspect_path)
    except (KeyError, OSError, tarfile.TarError, json.JSONDecodeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    with open(output_path, "w", encoding="utf-8") as output:
        json.dump(evidence, output, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
