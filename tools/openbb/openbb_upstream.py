#!/usr/bin/env python3
"""Fetch, verify, inventory, and safely gate the pinned OpenBB Workspace source."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM_LOCK = ROOT / "third_party" / "upstreams.lock.json"
TOOLCHAIN_LOCK = ROOT / "tools" / "openbb" / "toolchain.lock.json"
EXPECTED_REPOSITORY = "OpenBB-finance/workspace"
EXPECTED_COMMIT = "be00e95019a55d57af146919ee46b7e1a4859226"
EXPECTED_ARCHIVE_SHA256 = "4171aa8984c7c63e171239f8cda72c4bc950f1e068de33577035dc8e5d63e6a4"
REQUIRED_SOURCE_FILES = (
    "LICENSE",
    "NOTICE",
    "lite/Dockerfile",
    "lite/build-local.sh",
    "backend-api/backend/pyproject.toml",
    "backend-api/backend/poetry.lock",
    "terminalpro/package.json",
    "terminalpro/bun.lock",
    "terminalpro/src/main.tsx",
    "terminalpro/config-profiles/lite.locked.json",
)


class SupplyChainError(RuntimeError):
    """A source, integrity, or build policy check failed."""


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SupplyChainError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SupplyChainError(f"expected a JSON object in {path}")
    return value


def openbb_entry() -> dict[str, Any]:
    lock = read_json(UPSTREAM_LOCK)
    matches = [item for item in lock.get("sources", []) if item.get("name") == "OpenBB Workspace"]
    if len(matches) != 1:
        raise SupplyChainError("upstreams.lock.json must contain exactly one OpenBB Workspace entry")
    entry = matches[0]
    if entry.get("repository") != EXPECTED_REPOSITORY:
        raise SupplyChainError(f"OpenBB repository must remain {EXPECTED_REPOSITORY}")
    if entry.get("commit") != EXPECTED_COMMIT:
        raise SupplyChainError(
            "OpenBB commit changed; update the pinned commit, archive digest, license records, and tests in an explicit PR"
        )
    archive = entry.get("source_archive", {})
    expected_url = f"https://codeload.github.com/{EXPECTED_REPOSITORY}/tar.gz/{EXPECTED_COMMIT}"
    if archive.get("url") != expected_url:
        raise SupplyChainError("OpenBB source archive URL must be the codeload archive for the pinned commit")
    if archive.get("sha256") != EXPECTED_ARCHIVE_SHA256:
        raise SupplyChainError("OpenBB source archive SHA-256 changed; verify it from the pinned codeload archive")
    if not re.fullmatch(r"[0-9a-f]{64}", archive.get("sha256", "")):
        raise SupplyChainError("OpenBB source archive must have a lowercase SHA-256 digest")
    validate_license_records(entry.get("license_files"))
    gate = entry.get("build_gate", {})
    if gate.get("status") not in {"blocked", "approved"}:
        raise SupplyChainError("OpenBB build_gate.status must be blocked or approved")
    if gate.get("status") == "approved":
        evidence = gate.get("evidence")
        recipe = entry.get("build_recipe")
        if not isinstance(evidence, dict) or not evidence.get("review") or not isinstance(recipe, dict):
            raise SupplyChainError("an approved OpenBB build gate requires review evidence and a pinned build recipe")
    return entry


def cache_dir() -> Path:
    configured = os.environ.get("OPENBB_CACHE_DIR")
    return Path(configured).expanduser() if configured else Path(tempfile.gettempdir()) / "eqoboard-openbb-cache"


def archive_path() -> Path:
    return cache_dir() / f"workspace-{EXPECTED_COMMIT}.tar.gz"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_under(root: Path, relative: str, description: str) -> Path:
    """Resolve a repository/source-relative file and reject traversal or symlinks."""
    root = root.resolve()
    candidate = PurePosixPath(relative)
    if candidate.is_absolute() or "\\" in relative or any(part in ("", ".", "..") for part in candidate.parts):
        raise SupplyChainError(f"unsafe {description} path: {relative}")
    current = root
    for part in candidate.parts:
        current = current / part
        if current.is_symlink():
            raise SupplyChainError(f"symlink is not allowed in {description} path: {relative}")
    resolved = current.resolve()
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise SupplyChainError(f"{description} path must be an existing file under its root: {relative}")
    return resolved


def validate_license_records(records: Any) -> None:
    expected = {
        "LICENSE": "third_party/licenses/openbb-workspace/LICENSE",
        "NOTICE": "third_party/licenses/openbb-workspace/NOTICE",
    }
    if not isinstance(records, list) or len(records) != len(expected):
        raise SupplyChainError("OpenBB license_files must contain exactly the upstream LICENSE and NOTICE")
    seen: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise SupplyChainError("OpenBB license file record must be an object")
        upstream = record.get("upstream_path")
        if upstream not in expected or upstream in seen:
            raise SupplyChainError("OpenBB license_files must contain LICENSE and NOTICE exactly once")
        if record.get("local_path") != expected[upstream]:
            raise SupplyChainError(f"unexpected repository path for OpenBB {upstream}")
        if not re.fullmatch(r"[0-9a-f]{64}", record.get("sha256", "")):
            raise SupplyChainError(f"invalid SHA-256 for OpenBB {upstream}")
        seen.add(upstream)
    if seen != set(expected):
        raise SupplyChainError("OpenBB license_files must contain LICENSE and NOTICE")
    for upstream, local_path in expected.items():
        resolve_under(ROOT, local_path, f"copied OpenBB {upstream}")


def download_verified(url: str, expected_sha256: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        actual = sha256_file(destination)
        if actual == expected_sha256:
            return destination

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temporary = Path(temporary_name)
    request = urllib.request.Request(url, headers={"User-Agent": "eqoboard-openbb-supply-chain/1"})
    try:
        with os.fdopen(descriptor, "wb") as output:
            with urllib.request.urlopen(request, timeout=90) as response:
                shutil.copyfileobj(response, output)
        actual = sha256_file(temporary)
        if actual != expected_sha256:
            raise SupplyChainError(
                f"SHA-256 mismatch for {url}: expected {expected_sha256}, received {actual}"
            )
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def fetch_archive() -> Path:
    entry = openbb_entry()
    archive = entry["source_archive"]
    path = download_verified(archive["url"], archive["sha256"], archive_path())
    print(f"OpenBB source archive verified: {path}")
    print(f"commit={EXPECTED_COMMIT}")
    print(f"sha256={archive['sha256']}")
    return path


def safe_extract(archive: Path, destination: Path) -> None:
    """Extract a verified GitHub archive without links or path traversal."""
    root = destination.resolve()
    root.mkdir(parents=True, exist_ok=True)
    expected_prefix = f"workspace-{EXPECTED_COMMIT}"
    seen: set[Path] = set()
    with tarfile.open(archive, mode="r:gz") as bundle:
        for member in bundle.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or not path.parts or path.parts[0] != expected_prefix:
                raise SupplyChainError(f"unexpected member in pinned archive: {member.name}")
            relative_parts = path.parts[1:]
            if any(part in ("", ".", "..") for part in relative_parts):
                raise SupplyChainError(f"unsafe archive path: {member.name}")
            if not relative_parts:
                if not member.isdir():
                    raise SupplyChainError("archive root must be a directory")
                continue
            target = root.joinpath(*relative_parts)
            resolved = target.resolve()
            if not resolved.is_relative_to(root):
                raise SupplyChainError(f"archive path escapes destination: {member.name}")
            if resolved in seen:
                raise SupplyChainError(f"duplicate archive path: {member.name}")
            seen.add(resolved)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise SupplyChainError(f"links and special files are not allowed in source archive: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise SupplyChainError(f"cannot read archive member: {member.name}")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o777)


def license_file_checks(entry: dict[str, Any], source: Path) -> list[str]:
    problems: list[str] = []
    records = entry.get("license_files", [])
    if not records:
        return ["license_files is empty"]
    for record in records:
        upstream = resolve_under(source, record["upstream_path"], "upstream license")
        local = resolve_under(ROOT, record["local_path"], "copied license")
        expected = record.get("sha256", "")
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            problems.append(f"invalid license digest for {record.get('upstream_path')}")
            continue
        for path in (upstream, local):
            if not path.is_file():
                problems.append(f"missing required license file: {path}")
            elif sha256_file(path) != expected:
                problems.append(f"license file digest mismatch: {path}")
        if upstream.is_file() and local.is_file() and upstream.read_bytes() != local.read_bytes():
            problems.append(f"copied license file differs from upstream: {record['upstream_path']}")
    return problems


def dockerfile_logical_instructions(contents: str) -> list[str]:
    instructions: list[str] = []
    current = ""
    for line in contents.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        continued = stripped.endswith("\\")
        fragment = stripped[:-1].strip() if continued else stripped
        current = f"{current} {fragment}".strip()
        if continued:
            continue
        instructions.append(current)
        current = ""
    if current:
        instructions.append(current)
    return instructions


def verifies_archive_in_image_build(contents: str) -> bool:
    archive_name = f"workspace-{EXPECTED_COMMIT}.tar.gz"
    archive_path = f"source/{archive_name}"
    instructions = dockerfile_logical_instructions(contents)
    if any(item.upper().startswith("SHELL ") for item in instructions):
        return False
    add_with_checksum = re.compile(
        rf"^ADD\s+--checksum=sha256:{EXPECTED_ARCHIVE_SHA256}\s+"
        rf"https://codeload\.github\.com/{re.escape(EXPECTED_REPOSITORY)}/tar\.gz/"
        rf"{EXPECTED_COMMIT}\s+\S+\s*$",
        flags=re.IGNORECASE,
    )
    if any(add_with_checksum.match(item) for item in instructions):
        return True
    copy_targets: set[str] = set()
    for item in instructions:
        if not item.upper().startswith("COPY "):
            continue
        try:
            tokens = shlex.split(item)
        except ValueError:
            continue
        operands = [token for token in tokens[1:] if not token.startswith("--")]
        if len(operands) == 2 and operands[0] == archive_path and operands[1].startswith("/"):
            copy_targets.add(operands[1])
    for target in copy_targets:
        checksum_check = re.compile(
            rf"^RUN\s+echo\s+(?P<quote>['\"]){EXPECTED_ARCHIVE_SHA256}  "
            rf"\*?{re.escape(target)}(?P=quote)"
            rf"\s+\|\s+sha256sum\s+-c\s+-\s*$",
            flags=re.IGNORECASE,
        )
        if any(checksum_check.fullmatch(item) for item in instructions):
            return True
    return False


def inspect_build_blockers(source: Path, dockerfile_path: Path | None = None) -> list[dict[str, str]]:
    """Report known licensing and reproducibility blockers without building."""
    findings: list[dict[str, str]] = []
    terminal = source / "terminalpro"
    package_file = terminal / "package.json"
    dockerfile = dockerfile_path or source / "lite" / "Dockerfile"
    main_file = terminal / "src" / "main.tsx"
    commercial_patterns = re.compile(
        r"ag-grid-enterprise|ag-charts-enterprise|AllEnterpriseModule|"
        r"AgChartsEnterpriseModule|LicenseManager\.setLicenseKey|highcharts-react-official",
        flags=re.IGNORECASE,
    )
    commercial_references: list[str] = []
    source_root = terminal / "src"
    if source_root.is_dir():
        for source_file in source_root.rglob("*"):
            if source_file.is_file() and source_file.suffix.lower() in {".js", ".jsx", ".ts", ".tsx", ".json"}:
                try:
                    if commercial_patterns.search(source_file.read_text(encoding="utf-8")):
                        commercial_references.append(source_file.relative_to(source).as_posix())
                except (OSError, UnicodeDecodeError):
                    commercial_references.append(source_file.relative_to(source).as_posix())
    if commercial_references:
        findings.append({
            "id": "commercial-enterprise-code-remains",
            "detail": "Lite source still references enterprise or separately licensed frontend code: " + ", ".join(sorted(commercial_references)),
        })

    if package_file.is_file():
        package = read_json(package_file)
        dependencies = package.get("dependencies", {})
        enterprise = [name for name in ("ag-grid-enterprise", "ag-charts-enterprise") if name in dependencies]
        if enterprise:
            findings.append({
                "id": "commercial-grid-and-chart-packages",
                "detail": "terminalpro declares commercial dependencies: " + ", ".join(
                    f"{name}@{dependencies[name]}" for name in enterprise
                ),
            })
        highcharts = [name for name in ("highcharts", "highcharts-react-official") if name in dependencies]
        if highcharts:
            findings.append({
                "id": "highcharts-commercial-license",
                "detail": "terminalpro declares Highcharts packages requiring separate license review: " + ", ".join(
                    f"{name}@{dependencies[name]}" for name in highcharts
                ),
            })

    if main_file.is_file() and "LicenseManager.setLicenseKey" in main_file.read_text(encoding="utf-8"):
        findings.append({
            "id": "embedded-openbb-pro-enterprise-key",
            "detail": "terminalpro/src/main.tsx embeds and registers an OpenBB-Pro-scoped AG Grid/Charts Enterprise key",
        })

    if dockerfile.is_file():
        recipe = dockerfile.read_text(encoding="utf-8")
        if "terminalpro/package-lock.json" in recipe and not (terminal / "package-lock.json").is_file():
            findings.append({
                "id": "upstream-dockerfile-lockfile-mismatch",
                "detail": "Lite Dockerfile runs npm ci from package-lock.json, while this pinned terminalpro source only supplies bun.lock",
            })
        if re.search(r"poetry\s+lock\s+--no-update\s*\|\|\s*poetry\s+lock", recipe):
            findings.append({
                "id": "upstream-poetry-lock-fallback",
                "detail": "Lite Dockerfile silently regenerates poetry.lock if it is out of sync",
            })
        base_images = []
        stage_names: set[str] = set()
        for line in recipe.splitlines():
            tokens = line.split()
            if not tokens or tokens[0].upper() != "FROM":
                continue
            tokens = tokens[1:]
            while tokens and tokens[0].startswith("--"):
                if tokens[0] == "--platform" and len(tokens) > 1:
                    tokens = tokens[2:]
                else:
                    tokens = tokens[1:]
            if not tokens:
                continue
            image = tokens[0]
            if image.lower() not in stage_names and "@sha256:" not in image:
                base_images.append(image)
            if len(tokens) >= 3 and tokens[1].upper() == "AS":
                stage_names.add(tokens[2].lower())
        if base_images:
            findings.append({
                "id": "mutable-container-base-images",
                "detail": "Lite Dockerfile has unpinned base image references: " + ", ".join(base_images),
            })
        if not verifies_archive_in_image_build(recipe):
            findings.append({
                "id": "source-archive-not-verified-in-image-build",
                "detail": "the Lite build stage must verify the pinned source archive SHA-256 independently of the host preflight",
            })
        if not re.search(r"COPY\s+.*\bLICENSE\b", recipe) or not re.search(r"COPY\s+.*\bNOTICE\b", recipe):
            findings.append({
                "id": "license-notice-not-copied-into-image",
                "detail": "upstream Lite Dockerfile does not copy the Apache LICENSE and NOTICE into the resulting image",
            })

    if not (terminal / "package-lock.json").is_file() and not (terminal / "bun.lock").is_file():
        findings.append({
            "id": "missing-frontend-dependency-lock",
            "detail": "terminalpro has no supported package-manager lockfile",
        })
    return findings


def verify_archive(archive: Path) -> dict[str, Any]:
    entry = openbb_entry()
    expected = entry["source_archive"]["sha256"]
    actual = sha256_file(archive)
    if actual != expected:
        raise SupplyChainError(f"OpenBB archive SHA-256 mismatch: expected {expected}, received {actual}")

    with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-verify-") as temporary:
        source = Path(temporary) / "source"
        safe_extract(archive, source)
        missing = [path for path in REQUIRED_SOURCE_FILES if not (source / path).is_file()]
        if missing:
            raise SupplyChainError("pinned archive is missing required files: " + ", ".join(missing))
        license_problems = license_file_checks(entry, source)
        if license_problems:
            raise SupplyChainError("license/NOTICE verification failed: " + "; ".join(license_problems))
        findings = inspect_build_blockers(source)
    return {
        "repository": EXPECTED_REPOSITORY,
        "commit": EXPECTED_COMMIT,
        "archive_sha256": actual,
        "license_files": [item["upstream_path"] for item in entry["license_files"]],
        "build_gate": entry.get("build_gate", {}).get("status", "unset"),
        "build_findings": findings,
    }


def toolchain() -> dict[str, Any]:
    lock = read_json(TOOLCHAIN_LOCK)
    syft = lock.get("syft", {})
    if (
        syft.get("repository") != "anchore/syft"
        or not re.fullmatch(r"\d+\.\d+\.\d+", syft.get("version", ""))
        or syft.get("release_base_url") != f"https://github.com/anchore/syft/releases/download/v{syft.get('version')}"
    ):
        raise SupplyChainError("toolchain.lock.json must pin an exact Syft release")
    return syft


def install_verified_executable(archive: Path, expected_archive_sha256: str, destination: Path) -> Path:
    """Refresh a cached executable from the digest-verified archive on every use."""
    actual_archive_sha256 = sha256_file(archive)
    if actual_archive_sha256 != expected_archive_sha256:
        raise SupplyChainError("Syft release archive digest changed before extraction")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            with tarfile.open(archive, mode="r:gz") as bundle:
                members = [member for member in bundle.getmembers() if member.name == "syft"]
                if len(members) != 1 or not members[0].isfile():
                    raise SupplyChainError("pinned Syft archive does not contain exactly one regular syft binary")
                data = bundle.extractfile(members[0])
                if data is None:
                    raise SupplyChainError("cannot read Syft binary from verified release archive")
                with data:
                    shutil.copyfileobj(data, output)
        temporary.chmod(0o755)
        expected_binary_sha256 = sha256_file(temporary)
        if destination.is_symlink() or not destination.is_file() or sha256_file(destination) != expected_binary_sha256:
            os.replace(temporary, destination)
        if destination.is_symlink() or sha256_file(destination) != expected_binary_sha256:
            raise SupplyChainError("cached Syft executable differs from the verified release archive")
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def syft_binary() -> tuple[Path, str]:
    pinned = toolchain()
    system = sys.platform
    machine = platform.machine().lower()
    arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(machine, machine)
    platform_key = f"{system}/{arch}"
    record = pinned.get("archives", {}).get(platform_key)
    if not record:
        raise SupplyChainError(f"pinned Syft has no archive for {platform_key}")
    archive_url = f"{pinned['release_base_url']}/{record['file']}"
    local_archive = cache_dir() / "tools" / record["file"]
    verified = download_verified(archive_url, record["sha256"], local_archive)
    executable = local_archive.parent / f"syft-{pinned['version']}"
    executable = install_verified_executable(verified, record["sha256"], executable)
    version_output = subprocess.run(
        [str(executable), "version"], check=True, capture_output=True, text=True
    ).stdout
    match = re.search(r"^Version:\s+(\S+)", version_output, flags=re.MULTILINE)
    if not match or match.group(1) != pinned["version"]:
        raise SupplyChainError(f"Syft binary version does not match toolchain lock: {version_output.strip()}")
    return executable, pinned["version"]


def source_sbom(output_path: Path | None, archive: Path | None) -> None:
    verified = archive or fetch_archive()
    report = verify_archive(verified)
    syft, version = syft_binary()
    default_output = ROOT / "build" / "openbb" / f"workspace-source-{EXPECTED_COMMIT}.spdx.json"
    output = (output_path or default_output).expanduser()
    if not output.is_absolute():
        output = ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-sbom-") as temporary:
        source = Path(temporary) / "source"
        safe_extract(verified, source)
        command = [
            str(syft), "scan", f"dir:{source}",
            "--source-name", "OpenBB Workspace source archive",
            "--source-version", EXPECTED_COMMIT,
            "--base-path", str(source),
            "--quiet",
            "-o", f"spdx-json={output}",
        ]
        subprocess.run(command, check=True)
    sbom = read_json(output)
    if sbom.get("spdxVersion") != "SPDX-2.3" or not sbom.get("packages"):
        output.unlink(missing_ok=True)
        raise SupplyChainError("Syft did not produce a non-empty SPDX 2.3 source SBOM")
    print(json.dumps({
        "kind": "source-archive-sbom",
        "source_commit": report["commit"],
        "source_archive_sha256": report["archive_sha256"],
        "syft_version": version,
        "spdx_version": sbom["spdxVersion"],
        "package_count": len(sbom["packages"]),
        "output": str(output),
        "note": "This inventories the pinned source archive and declared/locked components; it is not an SBOM for a built runtime image.",
    }, indent=2))


def validate_recipe_assets(recipe: dict[str, Any]) -> list[tuple[str, Path, str]]:
    records = recipe.get("support_files", [])
    if not isinstance(records, list):
        raise SupplyChainError("build_recipe.support_files must be a list")
    validated: list[tuple[str, Path, str]] = []
    by_path: dict[str, str] = {}
    for record in records:
        if not isinstance(record, dict):
            raise SupplyChainError("OpenBB build support file record must be an object")
        relative = record.get("path", "")
        digest = record.get("sha256", "")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise SupplyChainError(f"invalid SHA-256 for OpenBB build support file: {relative}")
        if relative in by_path:
            raise SupplyChainError(f"duplicate OpenBB build support file: {relative}")
        path = resolve_under(ROOT, relative, "OpenBB build support file")
        if sha256_file(path) != digest:
            raise SupplyChainError(f"OpenBB build support file SHA-256 does not match: {relative}")
        by_path[relative] = digest
        validated.append((relative, path, digest))

    patch_record = recipe.get("source_patch")
    if patch_record is not None:
        if not isinstance(patch_record, dict):
            raise SupplyChainError("build_recipe.source_patch must be an object")
        runner = patch_record.get("runner")
        patches = patch_record.get("files")
        if not isinstance(runner, dict) or not isinstance(patches, list) or not patches:
            raise SupplyChainError("source_patch must pin a runner and one or more patch files")
        patch_assets = [runner, *patches]
        for item in patch_assets:
            relative = item.get("path", "") if isinstance(item, dict) else ""
            digest = item.get("sha256", "") if isinstance(item, dict) else ""
            if by_path.get(relative) != digest:
                raise SupplyChainError(
                    f"source patch asset must also be pinned in support_files: {relative}"
                )
    return validated


def build_identity(recipe: dict[str, Any], support_files: list[tuple[str, Path, str]]) -> str:
    identity_record = {
        "source_commit": EXPECTED_COMMIT,
        "source_archive_sha256": EXPECTED_ARCHIVE_SHA256,
        "variant": recipe.get("variant", "lite"),
        "recipe_sha256": recipe["sha256"],
        "support_files": [
            {"path": relative, "sha256": digest}
            for relative, _, digest in sorted(support_files, key=lambda item: item[0])
        ],
    }
    canonical = json.dumps(identity_record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def validate_immutable_tag(tag: str, identity: str) -> None:
    if "@" in tag or tag.endswith(":latest"):
        raise SupplyChainError("OpenBB builds require a content-specific local tag; latest and digest-only tags are rejected")
    image_name = tag.rsplit("/", 1)[-1]
    if ":" not in image_name:
        raise SupplyChainError("OpenBB image tag must include a content-specific tag component")
    tag_value = image_name.rsplit(":", 1)[1]
    if not tag_value.endswith(f"-{identity[:16]}"):
        raise SupplyChainError(
            f"OpenBB image tag must end with the locked build identity {identity[:16]}"
        )


def ensure_image_tag_available(tag: str, identity: str) -> None:
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", tag],
            check=False, capture_output=True, text=True,
        )
    except OSError as exc:
        raise SupplyChainError(f"cannot inspect Docker image tag {tag}: {exc}") from exc
    if result.returncode != 0:
        diagnostics = f"{result.stdout}\n{result.stderr}"
        if re.search(r"No such (?:image|object)", diagnostics, flags=re.IGNORECASE):
            return
        raise SupplyChainError(f"cannot verify whether OpenBB image tag exists: {tag}: {diagnostics.strip()}")
    try:
        labels = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SupplyChainError(f"cannot parse provenance labels for existing image {tag}") from exc
    if not isinstance(labels, dict) or labels.get("org.eqoboard.openbb.build.identity") != identity:
        raise SupplyChainError(f"refusing to overwrite existing OpenBB image tag with different provenance: {tag}")
    raise SupplyChainError(
        f"refusing to rebuild or overwrite existing content-specific OpenBB image tag: {tag}"
    )


def build_lite(tag: str | None, archive: Path | None) -> None:
    entry = openbb_entry()
    gate = entry.get("build_gate", {})
    if gate.get("status") != "approved":
        reasons = gate.get("required_findings_to_clear", [])
        print("OpenBB Lite image build blocked by the pinned build gate.", file=sys.stderr)
        for reason in reasons:
            print(f"- {reason}", file=sys.stderr)
        print("An explicit PR must clear the source findings, include review evidence, and pin a build recipe before this command can build.", file=sys.stderr)
        raise SystemExit(2)

    recipe = entry.get("build_recipe")
    if not isinstance(recipe, dict) or not recipe.get("path") or not recipe.get("sha256"):
        raise SupplyChainError("approved OpenBB build gate has no repository-pinned build_recipe path and SHA-256")
    recipe_path = resolve_under(ROOT, recipe["path"], "OpenBB build recipe")
    if sha256_file(recipe_path) != recipe["sha256"]:
        raise SupplyChainError("approved OpenBB build recipe is missing or its SHA-256 does not match the lock")
    support_files = validate_recipe_assets(recipe)
    identity = build_identity(recipe, support_files)

    verified = archive or fetch_archive()
    report = verify_archive(verified)
    with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-build-") as temporary:
        workspace = Path(temporary) / "source"
        safe_extract(verified, workspace)
        patch_record = recipe.get("source_patch")
        if patch_record:
            runner_path = next(path for relative, path, _ in support_files if relative == patch_record["runner"]["path"])
            patch_paths = [
                next(path for relative, path, _ in support_files if relative == item["path"])
                for item in patch_record["files"]
            ]
            command = [sys.executable, str(runner_path), "--source", str(workspace)]
            for patch_path in patch_paths:
                command.extend(["--patch", str(patch_path)])
            subprocess.run(command, cwd=ROOT, check=True)
        findings = inspect_build_blockers(workspace, recipe_path)
        if findings:
            raise SupplyChainError("source build blockers remain: " + "; ".join(item["id"] for item in findings))
        context = Path(temporary) / "context"
        context.mkdir()
        shutil.copytree(workspace / "lite", context, dirs_exist_ok=True)
        shutil.copytree(workspace / "terminalpro", context / "terminalpro")
        shutil.copytree(workspace / "backend-api" / "backend", context / "backend")
        source_context = context / "source"
        source_context.mkdir()
        source_archive = source_context / f"workspace-{EXPECTED_COMMIT}.tar.gz"
        shutil.copy2(verified, source_archive)
        (source_context / "archive.sha256").write_text(
            f"{report['archive_sha256']}  {source_archive.name}\n", encoding="ascii"
        )
        licenses = context / "licenses"
        licenses.mkdir()
        for record in entry["license_files"]:
            local = resolve_under(ROOT, record["local_path"], "copied OpenBB license")
            shutil.copy2(local, licenses / f"OPENBB-{Path(record['upstream_path']).name}")
        for relative, asset_path, _ in support_files:
            context_asset = context / PurePosixPath(relative)
            if context_asset.exists():
                raise SupplyChainError(f"OpenBB build support file collides with a source/context file: {relative}")
            context_asset.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(asset_path, context_asset)
        shutil.copy2(recipe_path, context / "Dockerfile")
        image_tag = tag or f"eqoboard/openbb-workspace:{EXPECTED_COMMIT}-{identity[:16]}"
        validate_immutable_tag(image_tag, identity)
        ensure_image_tag_available(image_tag, identity)
        subprocess.run([
            "docker", "buildx", "build", "--load", "--tag", image_tag,
            "--label", f"org.opencontainers.image.source=https://github.com/{EXPECTED_REPOSITORY}",
            "--label", f"org.opencontainers.image.revision={EXPECTED_COMMIT}",
            "--label", f"org.eqoboard.openbb.source.archive.sha256={report['archive_sha256']}",
            "--label", f"org.eqoboard.openbb.build.identity={identity}",
            "--build-arg", "OPENBB_IMAGE_VARIANT=lite", "--file", str(context / "Dockerfile"), str(context),
        ], check=True)
        image_id = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{.Id}}", image_tag],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        syft, syft_version = syft_binary()
        artifact_dir = ROOT / "build" / "openbb"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        sbom_path = artifact_dir / f"workspace-image-{EXPECTED_COMMIT}-{identity[:16]}.spdx.json"
        subprocess.run([
            str(syft), "scan", f"docker:{image_tag}",
            "--source-name", image_tag, "--source-version", EXPECTED_COMMIT,
            "--quiet", "-o", f"spdx-json={sbom_path}",
        ], check=True)
        sbom_digest = sha256_file(sbom_path)
        build_record = {
            "source_commit": EXPECTED_COMMIT,
            "source_archive_sha256": report["archive_sha256"],
            "image_tag": image_tag,
            "build_identity": identity,
            "local_image_id": image_id,
            "image_sbom": str(sbom_path),
            "image_sbom_sha256": sbom_digest,
            "syft_version": syft_version,
        }
        record_path = artifact_dir / f"workspace-image-{EXPECTED_COMMIT}.build.json"
        record_path.write_text(json.dumps(build_record, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(build_record, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("fetch", help="download the pinned archive and verify its SHA-256")
    verify = commands.add_parser("verify-source", help="verify archive, required source files, and copied licenses")
    verify.add_argument("--archive", type=Path)
    sbom = commands.add_parser("source-sbom", help="generate an SPDX SBOM for the pinned source archive")
    sbom.add_argument("--archive", type=Path)
    sbom.add_argument("--output", type=Path)
    build = commands.add_parser("build-lite", help="build only after the reviewed source build gate is approved")
    build.add_argument("--archive", type=Path)
    build.add_argument("--tag")
    commands.add_parser("build-gate", help="show why image construction is currently blocked")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "fetch":
            fetch_archive()
        elif args.command == "verify-source":
            archive = args.archive or fetch_archive()
            print(json.dumps(verify_archive(archive), indent=2))
        elif args.command == "source-sbom":
            source_sbom(args.output, args.archive)
        elif args.command == "build-lite":
            build_lite(args.tag, args.archive)
        elif args.command == "build-gate":
            entry = openbb_entry()
            gate = entry.get("build_gate", {})
            print(json.dumps({"status": gate.get("status"), "required_findings_to_clear": gate.get("required_findings_to_clear", []), "evidence": gate.get("evidence")}, indent=2))
        return 0
    except SupplyChainError as exc:
        print(f"OpenBB supply-chain error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
