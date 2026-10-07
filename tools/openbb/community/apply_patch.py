#!/usr/bin/env python3
"""Apply the reviewed OpenBB Workspace Community patch to one pinned source tree."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

UPSTREAM_REPOSITORY = "OpenBB-finance/workspace"
UPSTREAM_COMMIT = "be00e95019a55d57af146919ee46b7e1a4859226"
UPSTREAM_ARCHIVE_SHA256 = "4171aa8984c7c63e171239f8cda72c4bc950f1e068de33577035dc8e5d63e6a4"
SOURCE_ROOT = f"workspace-{UPSTREAM_COMMIT}"
LICENSE_CALL = re.compile(r"^LicenseManager\.setLicenseKey\(\s*\n.*?^\);\s*", re.MULTILINE | re.DOTALL)
HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$")


class PatchError(Exception):
    """Raised when the source or reviewed patch differs from its pinned contract."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def destination_mode(target: Path) -> int:
    if target.exists():
        return stat.S_IMODE(target.stat().st_mode)
    return stat.S_IRUSR | stat.S_IWUSR


def safe_relative_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise PatchError(f"unsafe repository path: {value!r}")
    if "\\" in value or "\x00" in value:
        raise PatchError(f"unsafe repository path: {value!r}")
    if path.parts[0] not in {"backend-api", "terminalpro", "lite"}:
        raise PatchError(f"patch path is outside the supported upstream trees: {value!r}")
    return path


def source_target(root: Path, rel: PurePosixPath, *, must_exist: bool) -> Path:
    target = root.joinpath(*rel.parts)
    cursor = root
    for part in rel.parts[:-1]:
        cursor = cursor / part
        if cursor.is_symlink():
            raise PatchError(f"symlink in source path: {rel.as_posix()}")
        if not cursor.exists():
            if must_exist:
                raise PatchError(f"missing source parent: {rel.as_posix()}")
            break
    if target.is_symlink():
        raise PatchError(f"symlink source target: {rel.as_posix()}")
    try:
        target.resolve(strict=False).relative_to(root)
    except ValueError as exc:
        raise PatchError(f"source path escapes pinned root: {rel.as_posix()}") from exc
    if must_exist and not target.is_file():
        raise PatchError(f"missing source file: {rel.as_posix()}")
    return target


def parse_patch(patch_bytes: bytes) -> list[dict[str, Any]]:
    try:
        lines = patch_bytes.decode("utf-8").splitlines(keepends=True)
    except UnicodeDecodeError as exc:
        raise PatchError("patch must be UTF-8 text") from exc

    parsed: list[dict[str, Any]] = []
    index = 0
    while index < len(lines):
        if not lines[index].startswith("--- "):
            raise PatchError(f"unexpected patch content at line {index + 1}")
        old_name = lines[index][4:].rstrip("\r\n").split("\t", 1)[0]
        index += 1
        if index >= len(lines) or not lines[index].startswith("+++ "):
            raise PatchError("patch file is missing its +++ header")
        new_name = lines[index][4:].rstrip("\r\n").split("\t", 1)[0]
        index += 1

        old_rel = None if old_name == "/dev/null" else safe_relative_path(old_name.removeprefix("a/"))
        new_rel = None if new_name == "/dev/null" else safe_relative_path(new_name.removeprefix("b/"))
        if old_rel is not None and old_name != f"a/{old_rel.as_posix()}":
            raise PatchError(f"unexpected old path prefix: {old_name!r}")
        if new_rel is not None and new_name != f"b/{new_rel.as_posix()}":
            raise PatchError(f"unexpected new path prefix: {new_name!r}")
        if old_rel is None and new_rel is None:
            raise PatchError("patch cannot add and delete /dev/null")
        if old_rel is not None and new_rel is not None and old_rel != new_rel:
            raise PatchError("renames are not supported by this reviewed patch")
        rel = new_rel or old_rel
        assert rel is not None

        hunks: list[dict[str, Any]] = []
        while index < len(lines) and not lines[index].startswith("--- "):
            header = lines[index].rstrip("\r\n")
            match = HUNK_HEADER.match(header)
            if not match:
                raise PatchError(f"unsupported patch directive at line {index + 1}")
            old_start = int(match.group(1))
            old_count = int(match.group(2) or "1")
            new_start = int(match.group(3))
            new_count = int(match.group(4) or "1")
            index += 1
            old_lines: list[str] = []
            new_lines: list[str] = []
            seen_old = seen_new = 0
            while index < len(lines) and (seen_old < old_count or seen_new < new_count):
                line = lines[index]
                if line.startswith("\\ No newline at end of file"):
                    raise PatchError("patches without final newlines are not supported")
                if not line or line[0] not in {" ", "+", "-"}:
                    raise PatchError(f"invalid hunk line at {index + 1}")
                content = line[1:]
                if line[0] in {" ", "-"}:
                    old_lines.append(content)
                    seen_old += 1
                if line[0] in {" ", "+"}:
                    new_lines.append(content)
                    seen_new += 1
                index += 1
            if seen_old != old_count or seen_new != new_count:
                raise PatchError("hunk line counts do not match its header")
            if len(old_lines) != old_count or len(new_lines) != new_count:
                raise PatchError("hunk contains inconsistent context")
            if new_count and new_start < 1:
                raise PatchError("invalid new line number")
            hunks.append({"old_start": old_start, "old_count": old_count, "old": old_lines, "new": new_lines})
        if not hunks:
            raise PatchError(f"patch has no hunks for {rel.as_posix()}")
        parsed.append({"path": rel, "old_path": old_rel, "new_path": new_rel, "hunks": hunks})

    if not parsed:
        raise PatchError("patch contains no file changes")
    if len({change["path"] for change in parsed}) != len(parsed):
        raise PatchError("patch changes one file more than once")
    return parsed


def apply_hunks(original: list[str], hunks: list[dict[str, Any]], path: str) -> list[str]:
    output = list(original)
    delta = 0
    for hunk in hunks:
        old_start = hunk["old_start"]
        old_count = hunk["old_count"]
        position = (old_start - 1 if old_count else old_start) + delta
        if position < 0 or position > len(output):
            raise PatchError(f"hunk offset is out of bounds for {path}")
        old_lines = hunk["old"]
        if output[position : position + len(old_lines)] != old_lines:
            raise PatchError(f"hunk preimage does not match exactly for {path} at line {old_start}")
        output[position : position + len(old_lines)] = hunk["new"]
        delta += len(hunk["new"]) - len(old_lines)
    return output


def load_manifest(patch: Path) -> dict[str, Any]:
    manifest_path = patch.with_name(patch.name + ".json")
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise PatchError(f"missing non-symlink patch manifest: {manifest_path}")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PatchError(f"cannot read patch manifest: {manifest_path}") from exc
    upstream = data.get("upstream", {})
    if data.get("schema_version") != 1:
        raise PatchError("unsupported patch manifest schema")
    if upstream != {
        "archive_sha256": UPSTREAM_ARCHIVE_SHA256,
        "commit": UPSTREAM_COMMIT,
        "repository": UPSTREAM_REPOSITORY,
        "source_root": SOURCE_ROOT,
    }:
        raise PatchError("patch manifest does not match the pinned upstream archive")
    if not isinstance(data.get("preimages"), dict) or not isinstance(data.get("postimages"), dict):
        raise PatchError("manifest preimages/postimages must be maps")
    if set(data["preimages"]) != set(data["postimages"]):
        raise PatchError("manifest preimage/postimage paths differ")
    return data


def apply(source: Path, patches: list[Path]) -> int:
    if source.is_symlink() or not source.is_dir() or source.name != SOURCE_ROOT:
        raise PatchError(f"source must be an extracted pinned tree named {SOURCE_ROOT}")
    root = source.resolve(strict=True)
    if source.absolute() != root:
        raise PatchError("source path must not contain symlink components")

    patch_inputs = []
    expected: dict[PurePosixPath, str | None] = {}
    expected_post: dict[PurePosixPath, str | None] = {}
    preprocess: list[dict[str, Any]] = []
    for patch in patches:
        if patch.is_symlink() or not patch.is_file():
            raise PatchError(f"patch must be a regular non-symlink file: {patch}")
        manifest = load_manifest(patch)
        changes = parse_patch(patch.read_bytes())
        paths = {change["path"] for change in changes}
        manifest_paths = {safe_relative_path(path) for path in manifest["preimages"]}
        if paths != manifest_paths:
            raise PatchError("manifest paths do not exactly match the patch")
        for rel, value in manifest["preimages"].items():
            safe = safe_relative_path(rel)
            if safe in expected:
                raise PatchError(f"multiple patches target {safe.as_posix()}")
            if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)):
                raise PatchError(f"invalid preimage digest for {rel}")
            post = manifest["postimages"][rel]
            if post is not None and (not isinstance(post, str) or not re.fullmatch(r"[0-9a-f]{64}", post)):
                raise PatchError(f"invalid postimage digest for {rel}")
            expected[safe] = value
            expected_post[safe] = post
        for item in manifest.get("preprocess", []):
            if item.get("action") != "remove_ag_license_registration" or item.get("expected_matches") != 1:
                raise PatchError("unsupported preprocessor operation")
            rel = safe_relative_path(item.get("path", ""))
            if rel not in paths or item.get("result_sha256") is None:
                raise PatchError("preprocessor path is not covered by patch digest manifest")
            preprocess.append({**item, "path": rel})
        patch_inputs.append(changes)

    # Verify every original source file before making any change.
    original_data: dict[PurePosixPath, bytes | None] = {}
    for rel, digest in expected.items():
        target = source_target(root, rel, must_exist=digest is not None)
        data = target.read_bytes() if target.exists() else None
        if digest is None:
            if data is not None:
                raise PatchError(f"new file already exists in source: {rel.as_posix()}")
        elif data is None or sha256(data) != digest:
            raise PatchError(f"upstream preimage SHA-256 mismatch: {rel.as_posix()}")
        original_data[rel] = data

    working: dict[PurePosixPath, bytes | None] = dict(original_data)
    for transform in preprocess:
        rel = transform["path"]
        data = working.get(rel)
        if data is None:
            raise PatchError(f"preprocessor source is missing: {rel.as_posix()}")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PatchError(f"preprocessor source is not UTF-8: {rel.as_posix()}") from exc
        transformed, count = LICENSE_CALL.subn("", text)
        if count != 1 or sha256(transformed.encode()) != transform["result_sha256"]:
            raise PatchError(f"AG license-call transform did not match reviewed source: {rel.as_posix()}")
        working[rel] = transformed.encode()

    for changes in patch_inputs:
        for change in changes:
            rel = change["path"]
            current = working.get(rel)
            if change["old_path"] is None:
                if current is not None:
                    raise PatchError(f"new-file patch would overwrite existing source: {rel.as_posix()}")
                current_lines: list[str] = []
            else:
                if current is None:
                    raise PatchError(f"patch source disappeared: {rel.as_posix()}")
                try:
                    current_lines = current.decode("utf-8").splitlines(keepends=True)
                except UnicodeDecodeError as exc:
                    raise PatchError(f"patch source is not UTF-8: {rel.as_posix()}") from exc
            updated = apply_hunks(current_lines, change["hunks"], rel.as_posix())
            if change["new_path"] is None:
                if updated:
                    raise PatchError(f"delete patch leaves content behind: {rel.as_posix()}")
                working[rel] = None
            else:
                encoded = "".join(updated).encode("utf-8")
                working[rel] = encoded if encoded else b""

    for rel, digest in expected_post.items():
        data = working[rel]
        actual = sha256(data) if data is not None else None
        if actual != digest:
            raise PatchError(f"reviewed postimage SHA-256 mismatch: {rel.as_posix()}")

    # All validation passed; atomically replace files and preserve upstream modes.
    for rel, data in working.items():
        target = source_target(root, rel, must_exist=original_data[rel] is not None)
        if data is None:
            if target.exists():
                target.unlink()
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = destination_mode(target)
        fd, temp_name = tempfile.mkstemp(prefix=".openbb-community-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temp_name, mode)
            os.replace(temp_name, target)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    return len(working)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="extracted pinned Workspace source directory")
    parser.add_argument("--patch", type=Path, action="append", required=True, help="reviewed patch (repeatable)")
    args = parser.parse_args()
    try:
        count = apply(args.source, args.patch)
    except PatchError as exc:
        parser.error(str(exc))
    print(f"Applied pinned OpenBB Community patch to {count} source files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
