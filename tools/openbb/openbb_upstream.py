#!/usr/bin/env python3
"""Fetch, verify, inventory, and safely gate the pinned OpenBB Workspace source."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from contextlib import ExitStack, contextmanager
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
EXPECTED_COMMUNITY_RECIPE = "tools/openbb/community/Dockerfile"
EXPECTED_COMMUNITY_RUNNER = "tools/openbb/community/apply_patch.py"
EXPECTED_COMMUNITY_PATCH = "tools/openbb/community/patches/community.patch"
EXPECTED_COMMUNITY_PATCH_MANIFEST = f"{EXPECTED_COMMUNITY_PATCH}.json"


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
    if gate.get("status") not in {"blocked", "local-buildable"}:
        raise SupplyChainError("OpenBB build_gate.status must be blocked or local-buildable")
    if gate.get("status") == "local-buildable":
        if not isinstance(entry.get("build_recipe"), dict):
            raise SupplyChainError("a local-buildable OpenBB gate requires a hash-pinned build recipe")
        if gate.get("required_findings_to_clear") != []:
            raise SupplyChainError("a local-buildable OpenBB gate cannot retain uncleared findings")
        _recipe, _recipe_path, _support_files, identity = locked_recipe(entry)
        validate_local_mock_evidence(entry, identity)
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


def validate_local_mock_evidence(entry: dict[str, Any], build_identity: str) -> dict[str, Any]:
    """Verify the separate local mock record without promoting release gates."""
    pointer = entry.get("local_mock_evidence")
    if not isinstance(pointer, dict):
        raise SupplyChainError("OpenBB local_mock_evidence must point to a versioned local record")
    relative = pointer.get("path")
    digest = pointer.get("sha256")
    tested_commit = pointer.get("tested_commit")
    if (
        pointer.get("scope") != "local-mock"
        or pointer.get("status") != "passed"
        or not isinstance(relative, str)
        or not isinstance(digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
        or not isinstance(tested_commit, str)
        or not re.fullmatch(r"[0-9a-f]{40}", tested_commit)
    ):
        raise SupplyChainError("OpenBB local_mock_evidence pointer has an invalid scope, status, path, or digest")
    path = resolve_under(ROOT, relative, "OpenBB local mock evidence")
    if sha256_file(path) != digest:
        raise SupplyChainError("OpenBB local mock evidence digest changed")
    record = read_json(path)
    record_upstream = record.get("upstream")
    if not isinstance(record_upstream, dict):
        raise SupplyChainError("OpenBB local mock evidence is missing its upstream identity")
    if (
        record.get("schema_version") != 1
        or record.get("scope") != "local-mock"
        or record.get("status") != "passed"
        or record.get("tested_commit") != tested_commit
        or record_upstream.get("openbb_workspace_commit") != entry.get("commit")
        or record_upstream.get("community_build_identity") != build_identity
    ):
        raise SupplyChainError("OpenBB local mock evidence does not match the locked source and recipe")
    return pointer


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
    print(f"OpenBB source archive verified: {path}", file=sys.stderr)
    print(f"commit={EXPECTED_COMMIT}", file=sys.stderr)
    print(f"sha256={archive['sha256']}", file=sys.stderr)
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
        "unpatched_upstream_findings": findings,
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


def normalized_sbom_packages(sbom: dict[str, Any]) -> frozenset[tuple[str, str]]:
    packages = sbom.get("packages")
    if not isinstance(packages, list) or not packages:
        raise SupplyChainError("Syft did not produce a non-empty package inventory")
    identities: set[tuple[str, str]] = set()
    for package in packages:
        if not isinstance(package, dict):
            raise SupplyChainError("Syft package inventory contains a malformed entry")
        if str(package.get("SPDXID", "")).startswith("SPDXRef-DocumentRoot-"):
            continue
        name = package.get("name")
        version = package.get("versionInfo", "")
        if not isinstance(name, str) or not name.strip() or not isinstance(version, str):
            raise SupplyChainError("Syft package inventory has a missing or malformed name/version")
        identities.add((name.strip(), version.strip()))
    return frozenset(identities)


def stable_sbom_scan(
    syft: Path,
    source: str,
    output: Path,
    source_name: str,
    source_version: str,
    base_path: Path | None = None,
) -> dict[str, Any]:
    """Run Syft three times and fail closed if lockfile cataloging is unstable."""
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-sbom-runs-") as temporary:
        scratch = Path(temporary)
        stable_packages: frozenset[tuple[str, str]] | None = None
        stable_count: int | None = None
        selected_sbom: dict[str, Any] | None = None
        selected_path: Path | None = None
        for index in range(3):
            candidate = scratch / f"scan-{index}.spdx.json"
            command = [
                str(syft), "scan", source,
                "--source-name", source_name,
                "--source-version", source_version,
                "--parallelism", "1",
                "--override-default-catalogers", "all",
                "--quiet",
            ]
            if base_path is not None:
                command.extend(["--base-path", str(base_path)])
            command.extend(["-o", f"spdx-json={candidate}"])
            environment = {
                key: value for key, value in os.environ.items()
                if not key.startswith("SYFT_")
            }
            # Syft 1.54.1 can nondeterministically drop production dependencies from Bun
            # locks with duplicate names when it excludes dev dependencies. Including the
            # full lock graph avoids that unsafe classification; repeat runs detect drift.
            environment.update({
                "SYFT_JAVASCRIPT_INCLUDE_DEV_DEPENDENCIES": "true",
                "SYFT_CACHE_TTL": "0",
                "SYFT_CHECK_FOR_APP_UPDATE": "false",
            })
            subprocess.run(command, check=True, env=environment)
            sbom = read_json(candidate)
            if sbom.get("spdxVersion") != "SPDX-2.3":
                raise SupplyChainError("Syft did not produce SPDX 2.3 output")
            identities = normalized_sbom_packages(sbom)
            package_count = len(sbom["packages"])
            if stable_packages is None:
                stable_packages = identities
                stable_count = package_count
                selected_sbom = sbom
                selected_path = candidate
            elif identities != stable_packages or package_count != stable_count:
                raise SupplyChainError(
                    "SBOM_UNVERIFIED: Syft produced an unstable normalized package name/version inventory "
                    f"for {source}; repeated scans reported {stable_count} and {package_count} package entries"
                )
        if selected_path is None or selected_sbom is None:
            raise SupplyChainError("Syft produced no SBOM scan result")
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
        )
        temporary_output = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as destination, selected_path.open("rb") as source_file:
                shutil.copyfileobj(source_file, destination)
            os.replace(temporary_output, output)
        finally:
            temporary_output.unlink(missing_ok=True)
        return selected_sbom


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
        sbom = stable_sbom_scan(
            syft,
            f"dir:{source}",
            output,
            "OpenBB Workspace source archive",
            EXPECTED_COMMIT,
            base_path=source,
        )
    identities = normalized_sbom_packages(sbom)
    package_set_digest = hashlib.sha256(
        json.dumps(sorted(identities), separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    print(json.dumps({
        "kind": "source-archive-sbom",
        "source_commit": report["commit"],
        "source_archive_sha256": report["archive_sha256"],
        "syft_version": version,
        "spdx_version": sbom["spdxVersion"],
        "package_count": len(sbom["packages"]),
        "normalized_package_identity_count": len(identities),
        "normalized_package_set_sha256": package_set_digest,
        "package_set_stability_runs": 3,
        "javascript_dev_dependencies_included": True,
        "output": str(output),
        "note": "This inventories the pinned source archive, including JavaScript dev dependencies so Bun lock production packages cannot be nondeterministically dropped; it is not an SBOM for a built runtime image.",
    }, indent=2))


def patched_source_sbom(output_path: Path | None, archive: Path | None) -> dict[str, Any]:
    """Inventory the verified community-patched tree, including its frozen frontend lock."""
    verified = archive or fetch_archive()
    source_report = verify_archive(verified)
    entry = openbb_entry()
    recipe, _recipe_path, support_files, identity = locked_recipe(entry)
    default_output = ROOT / "build" / "openbb" / (
        f"workspace-patched-source-{EXPECTED_COMMIT}-{identity[:16]}.spdx.json"
    )
    output = (output_path or default_output).expanduser()
    if not output.is_absolute():
        output = ROOT / output

    syft, version = syft_binary()
    with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-patched-sbom-") as temporary:
        workspace = Path(temporary) / f"workspace-{EXPECTED_COMMIT}"
        safe_extract(verified, workspace)
        apply_locked_source_patch(workspace, recipe, support_files)
        tree_sha256 = inventory_digest(inventory_source_tree(workspace))
        source_version = f"{EXPECTED_COMMIT}+community-{identity[:16]}"
        sbom = stable_sbom_scan(
            syft,
            f"dir:{workspace}",
            output,
            "OpenBB Workspace Community-patched source",
            source_version,
            base_path=workspace,
        )
    identities = normalized_sbom_packages(sbom)
    package_set_digest = hashlib.sha256(
        json.dumps(sorted(identities), separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    result = {
        "kind": "community-patched-source-sbom",
        "scope": "verified patched source tree and frozen dependency locks; not a runtime image SBOM",
        "source_commit": source_report["commit"],
        "source_archive_sha256": source_report["archive_sha256"],
        "source_tree_sha256": tree_sha256,
        "build_identity": identity,
        "recipe_sha256": recipe["sha256"],
        "syft_version": version,
        "spdx_version": sbom["spdxVersion"],
        "package_count": len(sbom["packages"]),
        "normalized_package_identity_count": len(identities),
        "normalized_package_set_sha256": package_set_digest,
        "package_set_stability_runs": 3,
        "javascript_dev_dependencies_included": True,
        "output": str(output),
        "sbom_sha256": sha256_file(output),
    }
    print(json.dumps(result, indent=2))
    return result


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
        if (
            not isinstance(runner, dict)
            or not isinstance(patches, list)
            or len(patches) != 1
            or not isinstance(patches[0], dict)
        ):
            raise SupplyChainError("OpenBB Community Docker recipe supports exactly one lock-pinned source patch")
        if runner.get("path") != EXPECTED_COMMUNITY_RUNNER:
            raise SupplyChainError("OpenBB Community source patch runner differs from the reviewed Docker recipe")
        if patches[0].get("path") != EXPECTED_COMMUNITY_PATCH:
            raise SupplyChainError("OpenBB Community source patch differs from the reviewed Docker recipe")
        if EXPECTED_COMMUNITY_PATCH_MANIFEST not in by_path:
            raise SupplyChainError("OpenBB Community patch manifest must be hash-pinned with its patch")
        patch_assets = [runner, *patches]
        for item in patch_assets:
            relative = item.get("path", "") if isinstance(item, dict) else ""
            digest = item.get("sha256", "") if isinstance(item, dict) else ""
            if by_path.get(relative) != digest:
                raise SupplyChainError(
                    f"source patch asset must also be pinned in support_files: {relative}"
                )
    return validated


def validate_docker_source_patch_contract(
    recipe: dict[str, Any],
    recipe_path: Path,
) -> None:
    """Fail closed unless Docker executes exactly the source patch represented by the lock."""
    if recipe.get("path") != EXPECTED_COMMUNITY_RECIPE:
        raise SupplyChainError("OpenBB Community build recipe path differs from the reviewed recipe contract")
    patch_record = recipe.get("source_patch", {})
    patch_files = patch_record.get("files", []) if isinstance(patch_record, dict) else []
    runner = patch_record.get("runner", {}) if isinstance(patch_record, dict) else {}
    if (
        not isinstance(runner, dict)
        or runner.get("path") != EXPECTED_COMMUNITY_RUNNER
        or len(patch_files) != 1
        or not isinstance(patch_files[0], dict)
        or patch_files[0].get("path") != EXPECTED_COMMUNITY_PATCH
    ):
        raise SupplyChainError("OpenBB Community Docker recipe supports exactly its single reviewed patch")

    instructions = dockerfile_logical_instructions(recipe_path.read_text(encoding="utf-8"))
    community_copies: list[list[str]] = []
    patch_runner_commands: list[list[str]] = []
    for instruction in instructions:
        try:
            tokens = shlex.split(instruction)
        except ValueError as exc:
            raise SupplyChainError(f"cannot parse pinned OpenBB Dockerfile instruction: {instruction}") from exc
        if not tokens:
            continue
        if tokens[0].upper() == "COPY" and any(
            token.startswith("tools/openbb/community/") for token in tokens[1:]
        ):
            community_copies.append(tokens)
        if tokens[0].upper() == "RUN" and "/opt/openbb-community/apply_patch.py" in tokens:
            patch_runner_commands.append(tokens)

    expected_copies = [
        ["COPY", EXPECTED_COMMUNITY_RUNNER, "/opt/openbb-community/apply_patch.py"],
        ["COPY", EXPECTED_COMMUNITY_PATCH, "/opt/openbb-community/community.patch"],
        ["COPY", EXPECTED_COMMUNITY_PATCH_MANIFEST, "/opt/openbb-community/community.patch.json"],
    ]
    if community_copies != expected_copies:
        raise SupplyChainError("pinned Dockerfile must copy exactly the lock-pinned OpenBB patch assets")
    expected_runner_command = [
        "RUN",
        "python",
        "/opt/openbb-community/apply_patch.py",
        "--source",
        f"/opt/workspace-{EXPECTED_COMMIT}",
        "--patch",
        "/opt/openbb-community/community.patch",
    ]
    if patch_runner_commands != [expected_runner_command]:
        raise SupplyChainError("pinned Dockerfile must apply exactly the single lock-pinned OpenBB source patch")


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


def locked_recipe(entry: dict[str, Any]) -> tuple[dict[str, Any], Path, list[tuple[str, Path, str]], str]:
    recipe = entry.get("build_recipe")
    if not isinstance(recipe, dict):
        raise SupplyChainError("OpenBB operation requires a lock-pinned build_recipe")
    recipe_path = resolve_under(ROOT, recipe.get("path", ""), "OpenBB build recipe")
    recipe_sha256 = recipe.get("sha256", "")
    if not re.fullmatch(r"[0-9a-f]{64}", recipe_sha256) or sha256_file(recipe_path) != recipe_sha256:
        raise SupplyChainError("OpenBB build recipe SHA-256 does not match the lock")
    support_files = validate_recipe_assets(recipe)
    validate_docker_source_patch_contract(recipe, recipe_path)
    return recipe, recipe_path, support_files, build_identity(recipe, support_files)


def apply_locked_source_patch(
    source: Path,
    recipe: dict[str, Any],
    support_files: list[tuple[str, Path, str]],
) -> None:
    expected_root = f"workspace-{EXPECTED_COMMIT}"
    if source.name != expected_root:
        raise SupplyChainError(f"OpenBB patch runner source directory must be named {expected_root}")
    patch_record = recipe.get("source_patch")
    if not isinstance(patch_record, dict):
        raise SupplyChainError("OpenBB operation requires a lock-pinned source_patch")
    support_by_path = {relative: path for relative, path, _ in support_files}
    runner_record = patch_record.get("runner")
    patch_records = patch_record.get("files")
    if (
        not isinstance(runner_record, dict)
        or runner_record.get("path") not in support_by_path
        or not isinstance(patch_records, list)
        or not patch_records
    ):
        raise SupplyChainError("OpenBB source patch must pin a runner and at least one patch file")
    if any(not isinstance(item, dict) or item.get("path") not in support_by_path for item in patch_records):
        raise SupplyChainError("OpenBB source patch references an unverified patch file")
    if len({item["path"] for item in patch_records}) != len(patch_records):
        raise SupplyChainError("OpenBB source patch file list contains duplicates")
    command = [
        sys.executable,
        str(support_by_path[runner_record["path"]]),
        "--source",
        str(source),
    ]
    for record in patch_records:
        command.extend(["--patch", str(support_by_path[record["path"]])])
    try:
        subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        diagnostics = getattr(exc, "stderr", "")
        message = str(exc)
        if diagnostics:
            message = f"{message}: {diagnostics.strip()}"
        raise SupplyChainError(f"pinned OpenBB source patch failed: {message}") from exc


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


@contextmanager
def _advisory_lock(path: Path):
    lock_root = local_build_lock_root()
    if path.parent != lock_root:
        raise SupplyChainError("OpenBB build lock path is outside the user-private lock directory")
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as exc:
        raise SupplyChainError(f"cannot open OpenBB build lock {path}: {exc}") from exc
    try:
        lock_stat = os.fstat(descriptor)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid != os.getuid():
            raise SupplyChainError(f"OpenBB build lock must be a regular file: {path}")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def local_build_lock_root() -> Path:
    """Create/validate a stable per-user cache lock directory shared by worktrees."""
    configured = os.environ.get("XDG_CACHE_HOME")
    cache_base = Path(configured).expanduser() if configured else Path.home() / ".cache"
    if not cache_base.is_absolute():
        raise SupplyChainError("XDG_CACHE_HOME must be an absolute path for OpenBB build locking")
    cache_base = cache_base.resolve()
    try:
        cache_base.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except OSError as exc:
        raise SupplyChainError(f"cannot create OpenBB cache directory {cache_base}: {exc}") from exc
    if cache_base.is_symlink() or not cache_base.is_dir():
        raise SupplyChainError(f"OpenBB cache path must be a real directory: {cache_base}")
    cache_stat = cache_base.stat()
    if cache_stat.st_uid != os.getuid() or cache_stat.st_mode & 0o022:
        raise SupplyChainError(f"OpenBB cache directory must be owned by this user and not group/world writable: {cache_base}")

    lock_root = cache_base
    for component in ("eqoboard", "openbb", "build-locks"):
        lock_root = lock_root / component
        try:
            lock_root.mkdir(mode=0o700)
        except FileExistsError:
            pass
        except OSError as exc:
            raise SupplyChainError(f"cannot create OpenBB build lock directory {lock_root}: {exc}") from exc
        if lock_root.is_symlink() or not lock_root.is_dir():
            raise SupplyChainError(f"OpenBB build lock path must be a real directory: {lock_root}")
        directory_stat = lock_root.stat()
        if directory_stat.st_uid != os.getuid() or stat.S_IMODE(directory_stat.st_mode) != 0o700:
            raise SupplyChainError(f"OpenBB build lock directory must be owner-only mode 0700: {lock_root}")
    return lock_root


@contextmanager
def image_build_lock(identity: str, tag: str):
    """Serialize helper builds across worktrees by identity and local image tag."""
    lock_root = local_build_lock_root()
    tag_digest = hashlib.sha256(tag.encode("utf-8")).hexdigest()
    lock_paths = sorted((
        lock_root / f"identity-{identity}.lock",
        lock_root / f"tag-{tag_digest}.lock",
    ))
    with ExitStack() as stack:
        for lock_path in lock_paths:
            stack.enter_context(_advisory_lock(lock_path))
        yield


def ensure_build_record_available(path: Path) -> None:
    if path.is_symlink() or path.exists():
        raise SupplyChainError(f"refusing to overwrite existing OpenBB build record: {path}")


def write_json_exclusive(path: Path, value: dict[str, Any]) -> None:
    """Publish a new immutable JSON record without replacing an existing path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError as exc:
            raise SupplyChainError(f"refusing to overwrite existing OpenBB build record: {path}") from exc
    finally:
        temporary.unlink(missing_ok=True)


def inventory_source_tree(root: Path) -> dict[str, dict[str, Any]]:
    """Hash every regular file and mode, rejecting links and special files."""
    if root.is_symlink() or not root.is_dir():
        raise SupplyChainError(f"OpenBB drift tree must be a regular directory: {root}")
    inventory: dict[str, dict[str, Any]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise SupplyChainError(f"OpenBB drift tree contains a symlink: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise SupplyChainError(f"OpenBB drift tree contains a special file: {path}")
        relative = path.relative_to(root).as_posix()
        if relative in inventory:
            raise SupplyChainError(f"duplicate path in OpenBB drift tree: {relative}")
        inventory[relative] = {
            "sha256": sha256_file(path),
            "mode": f"{path.stat().st_mode & 0o777:04o}",
        }
    return inventory


def inventory_digest(inventory: dict[str, dict[str, Any]]) -> str:
    canonical = json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def compare_source_trees(upstream: Path, patched: Path) -> dict[str, Any]:
    """Classify file-level differences between verified source and a pinned patch result."""
    original = inventory_source_tree(upstream)
    adapted = inventory_source_tree(patched)
    files: list[dict[str, Any]] = []
    counts = {
        "exact_upstream_files": 0,
        "modified_upstream_files": 0,
        "eqoboard_only_files": 0,
        "deleted_upstream_files": 0,
    }
    for relative in sorted(original.keys() | adapted.keys()):
        before = original.get(relative)
        after = adapted.get(relative)
        if before is None:
            classification = "eqoboard-only"
            counts["eqoboard_only_files"] += 1
        elif after is None:
            classification = "deleted-upstream"
            counts["deleted_upstream_files"] += 1
        elif before == after:
            classification = "exact-upstream"
            counts["exact_upstream_files"] += 1
        else:
            classification = "modified-upstream"
            counts["modified_upstream_files"] += 1
        files.append({
            "path": relative,
            "classification": classification,
            "upstream_sha256": before["sha256"] if before else None,
            "upstream_mode": before["mode"] if before else None,
            "patched_sha256": after["sha256"] if after else None,
            "patched_mode": after["mode"] if after else None,
        })
    return {
        "counts": counts | {
            "upstream_files": len(original),
            "patched_files": len(adapted),
        },
        "upstream_tree_sha256": inventory_digest(original),
        "patched_tree_sha256": inventory_digest(adapted),
        "files": files,
    }


def write_json_atomically(output: Path, value: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def openbb_upstream_diff(archive: Path | None, output: Path | None) -> dict[str, Any]:
    """Verify and apply only the lock-pinned patch before recording upstream drift."""
    entry = openbb_entry()
    verified = archive or fetch_archive()
    source_report = verify_archive(verified)
    recipe, recipe_path, support_files, build_hash = locked_recipe(entry)
    patch_record = recipe["source_patch"]
    runner_record = patch_record["runner"]

    with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-diff-") as temporary:
        temporary_root = Path(temporary)
        upstream_parent = temporary_root / "upstream"
        patched_parent = temporary_root / "patched"
        upstream_parent.mkdir()
        patched_parent.mkdir()
        pinned_root = f"workspace-{EXPECTED_COMMIT}"
        upstream = upstream_parent / pinned_root
        patched = patched_parent / pinned_root
        safe_extract(verified, upstream)
        shutil.copytree(upstream, patched)
        apply_locked_source_patch(patched, recipe, support_files)
        comparison = compare_source_trees(upstream, patched)
        comparison["remaining_build_findings"] = inspect_build_blockers(patched, recipe_path)

    report = {
        "schema_version": 1,
        "kind": "openbb-upstream-diff",
        "upstream": {
            "repository": source_report["repository"],
            "commit": source_report["commit"],
            "source_archive_sha256": source_report["archive_sha256"],
        },
        "build_variant": recipe.get("variant", "lite"),
        "build_identity": build_hash,
        "recipe": {"path": recipe["path"], "sha256": recipe["sha256"]},
        "support_files": [
            {"path": relative, "sha256": digest}
            for relative, _, digest in sorted(support_files, key=lambda item: item[0])
        ],
        "source_patch": {
            "runner": {
                "path": runner_record["path"],
                "sha256": runner_record["sha256"],
            },
            "files": [
                {"path": item["path"], "sha256": item["sha256"]}
                for item in patch_record["files"]
            ],
        },
        **comparison,
    }
    target = output.expanduser() if output is not None else (
        ROOT / "build" / "openbb" / f"workspace-diff-{EXPECTED_COMMIT}.json"
    )
    if not target.is_absolute():
        target = ROOT / target
    write_json_atomically(target, report)
    report["output"] = str(target)
    return report


def build_lite(tag: str | None, archive: Path | None) -> None:
    entry = openbb_entry()
    gate = entry.get("build_gate", {})
    if gate.get("status") != "local-buildable":
        reasons = gate.get("required_findings_to_clear", [])
        print("OpenBB Lite local image build blocked by the pinned build gate.", file=sys.stderr)
        for reason in reasons:
            print(f"- {reason}", file=sys.stderr)
        print("An explicit source/recipe update must clear the findings and pin every build input before local construction is allowed.", file=sys.stderr)
        raise SystemExit(2)

    recipe, recipe_path, support_files, identity = locked_recipe(entry)
    image_tag = tag or f"eqoboard/openbb-workspace:{EXPECTED_COMMIT}-{identity[:16]}"
    validate_immutable_tag(image_tag, identity)
    artifact_dir = ROOT / "build" / "openbb"
    record_path = artifact_dir / f"workspace-image-{EXPECTED_COMMIT}-{identity}.build.json"

    # The locks cover preflight, immutable-tag inspection, Docker build, SBOM, and
    # record publication. A second helper process must observe the first one's result.
    with image_build_lock(identity, image_tag):
        ensure_build_record_available(record_path)
        ensure_image_tag_available(image_tag, identity)
        _build_lite_under_lock(
            entry,
            recipe,
            recipe_path,
            support_files,
            identity,
            image_tag,
            archive,
            artifact_dir,
            record_path,
        )


def _build_lite_under_lock(
    entry: dict[str, Any],
    recipe: dict[str, Any],
    recipe_path: Path,
    support_files: list[tuple[str, Path, str]],
    identity: str,
    image_tag: str,
    archive: Path | None,
    artifact_dir: Path,
    record_path: Path,
) -> None:
    verified = archive or fetch_archive()
    report = verify_archive(verified)
    with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-build-") as temporary:
        workspace = Path(temporary) / f"workspace-{EXPECTED_COMMIT}"
        safe_extract(verified, workspace)
        apply_locked_source_patch(workspace, recipe, support_files)
        findings = inspect_build_blockers(workspace, recipe_path)
        if findings:
            raise SupplyChainError("source build blockers remain: " + "; ".join(item["id"] for item in findings))
        patched_tree_sha256 = inventory_digest(inventory_source_tree(workspace))
        syft, syft_version = syft_binary()
        artifact_dir.mkdir(parents=True, exist_ok=True)
        patched_source_sbom_path = artifact_dir / (
            f"workspace-patched-source-{EXPECTED_COMMIT}-{identity[:16]}.spdx.json"
        )
        patched_source_sbom = stable_sbom_scan(
            syft,
            f"dir:{workspace}",
            patched_source_sbom_path,
            "OpenBB Workspace Community-patched source",
            f"{EXPECTED_COMMIT}+community-{identity[:16]}",
            base_path=workspace,
        )
        patched_source_sbom_sha256 = sha256_file(patched_source_sbom_path)
        patched_source_identities = normalized_sbom_packages(patched_source_sbom)
        patched_source_set_sha256 = hashlib.sha256(
            json.dumps(sorted(patched_source_identities), separators=(",", ":")).encode("utf-8")
        ).hexdigest()
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
        for license_record in entry["license_files"]:
            local = resolve_under(ROOT, license_record["local_path"], "copied OpenBB license")
            shutil.copy2(local, licenses / f"OPENBB-{Path(license_record['upstream_path']).name}")
        for relative, asset_path, _ in support_files:
            context_asset = context / PurePosixPath(relative)
            if context_asset.exists():
                raise SupplyChainError(f"OpenBB build support file collides with a source/context file: {relative}")
            context_asset.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(asset_path, context_asset)
        shutil.copy2(recipe_path, context / "Dockerfile")
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
        sbom_path = artifact_dir / f"workspace-image-{EXPECTED_COMMIT}-{identity[:16]}.spdx.json"
        stable_sbom_scan(
            syft,
            f"docker:{image_tag}",
            sbom_path,
            image_tag,
            EXPECTED_COMMIT,
        )
        sbom_digest = sha256_file(sbom_path)
        build_record = {
            "source_commit": EXPECTED_COMMIT,
            "source_archive_sha256": report["archive_sha256"],
            "image_tag": image_tag,
            "build_identity": identity,
            "patched_source_tree_sha256": patched_tree_sha256,
            "patched_source_sbom": str(patched_source_sbom_path),
            "patched_source_sbom_sha256": patched_source_sbom_sha256,
            "patched_source_package_count": len(patched_source_sbom["packages"]),
            "patched_source_package_identity_count": len(patched_source_identities),
            "patched_source_package_set_sha256": patched_source_set_sha256,
            "local_image_id": image_id,
            "image_sbom": str(sbom_path),
            "image_sbom_sha256": sbom_digest,
            "image_sbom_scope_note": "This scans the runtime image. The Vite frontend is a compiled dist bundle without Bun/npm package metadata; use the linked patched-source SBOM for the locked frontend dependency inventory.",
            "syft_version": syft_version,
            "build_record": str(record_path),
        }
        write_json_exclusive(record_path, build_record)
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
    patched_sbom = commands.add_parser(
        "patched-source-sbom",
        help="generate an SPDX SBOM for the lock-pinned Community-patched source tree",
    )
    patched_sbom.add_argument("--archive", type=Path)
    patched_sbom.add_argument("--output", type=Path)
    build = commands.add_parser("build-lite", help="build locally only when the pinned source/recipe gate permits it")
    build.add_argument("--archive", type=Path)
    build.add_argument("--tag")
    drift = commands.add_parser(
        "upstream-diff",
        help="compare verified OpenBB source with the source tree produced by the pinned community patch",
    )
    drift.add_argument("--archive", type=Path)
    drift.add_argument("--output", type=Path)
    commands.add_parser("build-gate", help="show local mock evidence separately from the release gate")
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
        elif args.command == "patched-source-sbom":
            patched_source_sbom(args.output, args.archive)
        elif args.command == "build-lite":
            build_lite(args.tag, args.archive)
        elif args.command == "upstream-diff":
            report = openbb_upstream_diff(args.archive, args.output)
            print(json.dumps({
                "kind": report["kind"],
                "upstream": report["upstream"],
                "recipe": report["recipe"],
                "counts": report["counts"],
                "upstream_tree_sha256": report["upstream_tree_sha256"],
                "patched_tree_sha256": report["patched_tree_sha256"],
                "output": report.get("output"),
            }, indent=2))
        elif args.command == "build-gate":
            entry = openbb_entry()
            gate = entry.get("build_gate", {})
            local_build = gate.get("status") == "local-buildable"
            print(json.dumps({
                "status": gate.get("status"),
                "local_build_allowed": local_build,
                "deployment_approved": gate.get("deployment") == "approved",
                "runtime_acceptance": gate.get("runtime_acceptance", "not-verified"),
                "browser_e2e": gate.get("browser_e2e", "not-run"),
                "deployment": gate.get("deployment", "not-approved"),
                "required_findings_to_clear": gate.get("required_findings_to_clear", []),
                "evidence": gate.get("evidence"),
                "local_mock_evidence": entry.get("local_mock_evidence"),
            }, indent=2))
        return 0
    except SupplyChainError as exc:
        print(f"OpenBB supply-chain error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
