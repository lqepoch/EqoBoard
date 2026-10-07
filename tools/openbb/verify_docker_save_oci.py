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
    inspect_os = inspect.get("Os")
    inspect_architecture = inspect.get("Architecture")
    if (
        not isinstance(inspect_os, str)
        or not inspect_os
        or not isinstance(inspect_architecture, str)
        or not inspect_architecture
    ):
        raise ValueError("Docker image inspect is missing its OS or architecture")
    platform = f"{inspect_os}/{inspect_architecture}"

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
            if not isinstance(root_index, dict):
                raise ValueError("OCI root index must be an object")
            root_index_digest = _digest(root_index_bytes)
            root_descriptors = root_index.get("manifests", [])
            if not isinstance(root_descriptors, list):
                raise ValueError("OCI root index manifests must be a list")

            observed_sizes: dict[str, int] = {}
            verified_digests: set[str] = set()
            expanded_indexes: set[tuple[tuple[str, str], ...]] = set()
            target_manifests: list[dict[str, Any]] = []

            def visit_descriptor(descriptor: dict[str, Any], path: tuple[dict[str, Any], ...]) -> None:
                if not isinstance(descriptor, dict):
                    raise ValueError("OCI index child must be a descriptor object")
                digest = descriptor.get("digest", "")
                media_type = descriptor.get("mediaType", "")
                if not isinstance(media_type, str) or not media_type:
                    raise ValueError("OCI descriptor is missing its media type")
                if not (
                    media_type.endswith("image.index.v1+json")
                    or media_type.endswith("image.manifest.v1+json")
                ):
                    raise ValueError(f"unsupported OCI descriptor media type: {media_type}")
                # Validate every descriptor occurrence, including duplicates, before
                # using the expansion cache. A duplicate cannot smuggle a false size.
                blob = _verify_descriptor(
                    archive,
                    descriptor,
                    observed_sizes,
                    verified_digests,
                    include_bytes=True,
                )

                if media_type.endswith("image.index.v1+json"):
                    index_path = tuple(
                        (item["digest"], json.dumps(item.get("platform"), sort_keys=True))
                        for item in path
                        if item.get("mediaType", "").endswith("image.index.v1+json")
                    )
                    if index_path in expanded_indexes:
                        return
                    expanded_indexes.add(index_path)
                    nested = json.loads(blob or b"")
                    if not isinstance(nested, dict):
                        raise ValueError(f"OCI nested index must be an object: {digest}")
                    children = nested.get("manifests", [])
                    if not isinstance(children, list):
                        raise ValueError(f"OCI nested index manifests must be a list: {digest}")
                    for child in children:
                        visit_descriptor(child, path + (child,))
                    return

                if media_type.endswith("image.manifest.v1+json"):
                    manifest = json.loads(blob or b"")
                    if not isinstance(manifest, dict):
                        raise ValueError(f"OCI image manifest must be an object: {digest}")
                    config = manifest.get("config")
                    layers = manifest.get("layers", [])
                    if not isinstance(config, dict) or not isinstance(layers, list):
                        raise ValueError(f"OCI image manifest is missing config or layer descriptors: {digest}")
                    oci_config_digest = config.get("digest")
                    _verify_descriptor(archive, config, observed_sizes, verified_digests, include_bytes=False)
                    layer_digests: list[str] = []
                    for layer in layers:
                        if not isinstance(layer, dict):
                            raise ValueError(f"OCI image layer must be a descriptor object: {digest}")
                        _verify_descriptor(archive, layer, observed_sizes, verified_digests, include_bytes=False)
                        layer_digests.append(layer.get("digest", ""))

                    # The Docker-save config and ordered layer digests identify the
                    # image being inspected. Platform metadata from unrelated
                    # manifests (including BuildKit attestations) cannot select it.
                    if oci_config_digest == config_digest and layer_digests == [
                        item["digest"] for item in docker_layers
                    ]:
                        index_chain = [
                            item["digest"]
                            for item in path
                            if item.get("mediaType", "").endswith("image.index.v1+json")
                        ]
                        target_manifests.append({
                            "descriptor": descriptor,
                            "manifest": manifest,
                            "index_chain": index_chain,
                            "path": path,
                        })
                    return

                raise ValueError(f"unsupported OCI descriptor media type: {media_type}")

            for descriptor in root_descriptors:
                visit_descriptor(descriptor, (descriptor,))
            if len(target_manifests) != 1:
                raise ValueError(
                    "expected one OCI application manifest matching the Docker-save config and ordered layers, "
                    f"found {len(target_manifests)}"
                )

            app = target_manifests[0]
            app_descriptor = app["descriptor"]
            app_manifest = app["manifest"]
            app_config = app_manifest["config"]
            app_layers = app_manifest["layers"]
            app_config_bytes = _member_bytes(
                archive,
                "blobs/sha256/" + app_config["digest"].removeprefix("sha256:"),
            )
            try:
                app_config_document = json.loads(app_config_bytes)
            except json.JSONDecodeError as exc:
                raise ValueError(f"OCI target image config is not valid JSON: {app_config['digest']}") from exc
            if not isinstance(app_config_document, dict):
                raise ValueError(f"OCI target image config is not an object: {app_config['digest']}")
            config_os = app_config_document.get("os")
            config_architecture = app_config_document.get("architecture")
            if (
                not isinstance(config_os, str)
                or not config_os
                or not isinstance(config_architecture, str)
                or not config_architecture
            ):
                raise ValueError(f"OCI target image config is missing OS or architecture: {app_config['digest']}")
            config_platform = f"{config_os}/{config_architecture}"
            if config_platform != platform:
                raise ValueError(
                    f"OCI target image config platform {config_platform} does not match Docker inspect {platform}"
                )

            declared_platforms: set[str] = set()
            for ancestor in app["path"]:
                platform_descriptor = ancestor.get("platform")
                if platform_descriptor is None:
                    continue
                if not isinstance(platform_descriptor, dict):
                    raise ValueError("OCI target descriptor platform is not an object")
                os_name = platform_descriptor.get("os")
                architecture = platform_descriptor.get("architecture")
                if (
                    not isinstance(os_name, str)
                    or not os_name
                    or not isinstance(architecture, str)
                    or not architecture
                ):
                    raise ValueError("OCI target descriptor has an incomplete platform claim")
                declared_platforms.add(f"{os_name}/{architecture}")
            if len(declared_platforms) > 1:
                raise ValueError("OCI target index chain contains conflicting platform claims")
            if declared_platforms and declared_platforms != {config_platform}:
                raise ValueError(
                    "OCI target descriptor platform does not match Docker-save config and Docker inspect"
                )

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
            if observed_index is None and not target_indexes:
                observed_index = root_index_digest

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
