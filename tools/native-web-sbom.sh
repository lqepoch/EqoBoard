#!/usr/bin/env bash
set -Eeuo pipefail

# Emit the native app source/lock SBOM and the production image SBOM from its
# inspected immutable config digest. Output stays under RUNNER_TEMP.
if [[ ${GITHUB_ACTIONS:-} != true ]]; then
  printf '%s\n' 'Native web SBOM generation must run in GitHub Actions.' >&2
  exit 2
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${NATIVE_CANDIDATE_SHA:?NATIVE_CANDIDATE_SHA must identify the checked-out candidate commit}"
: "${NATIVE_WEB_IMAGE:?NATIVE_WEB_IMAGE must identify the production image}"
: "${NATIVE_IMAGE_CONFIG_DIGEST:?NATIVE_IMAGE_CONFIG_DIGEST must identify the built image config}"
: "${NATIVE_IMAGE_BUILD_DIGEST:?NATIVE_IMAGE_BUILD_DIGEST must identify the build output manifest}"

if [[ ! "$NATIVE_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'NATIVE_CANDIDATE_SHA must be a full lowercase commit SHA; got: %s\n' "$NATIVE_CANDIDATE_SHA" >&2
  exit 2
fi
for digest_name in NATIVE_IMAGE_CONFIG_DIGEST NATIVE_IMAGE_BUILD_DIGEST; do
  digest_value="${!digest_name}"
  if [[ ! "$digest_value" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s must be sha256 followed by 64 lowercase hex characters.\n' "$digest_name" >&2
    exit 2
  fi
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! checkout_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null)"; then
  printf 'Could not resolve the checked-out candidate commit in %s.\n' "$repo_root" >&2
  exit 2
fi
if [[ ! "$checkout_sha" =~ ^[0-9a-f]{40}$ || "$checkout_sha" != "$NATIVE_CANDIDATE_SHA" ]]; then
  printf 'NATIVE_CANDIDATE_SHA (%s) does not match checked-out HEAD (%s).\n' \
    "$NATIVE_CANDIDATE_SHA" "$checkout_sha" >&2
  exit 2
fi
# BEGIN bounded candidate source drift diagnostic. It records path/status only.
python3 - "$repo_root" "$NATIVE_CANDIDATE_SHA" "$RUNNER_TEMP" <<'PY'
import json
import os
import pathlib
import subprocess
import sys

MAX_DIAGNOSTIC_PATHS = 32
repo_root, candidate_sha, runner_temp_raw = sys.argv[1:]
runner_temp = pathlib.Path(runner_temp_raw).resolve(strict=True)
metadata_path = runner_temp / "native-web-source-drift.json"
counts = {"tracked": 0, "untracked": 0}
listed = {"tracked": [], "untracked": []}
listed_path_count = 0


def nul_fields(stream):
    buffer = b""
    while True:
        chunk = stream.read(8192)
        if not chunk:
            break
        buffer += chunk
        while b"\0" in buffer:
            field, buffer = buffer.split(b"\0", 1)
            yield field
    if buffer:
        yield buffer


def git_fields(arguments):
    try:
        process = subprocess.Popen(
            ["git", "-C", repo_root, *arguments],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        raise RuntimeError("could not start the Git source-path inspection") from None
    assert process.stdout is not None
    try:
        yield from nul_fields(process.stdout)
    finally:
        process.stdout.close()
    if process.wait() != 0:
        raise RuntimeError("Git source-path inspection failed")


def record(category, status, raw_path):
    global listed_path_count
    counts[category] += 1
    if listed_path_count < MAX_DIAGNOSTIC_PATHS:
        listed[category].append({"status": status, "path": os.fsdecode(raw_path)})
        listed_path_count += 1


try:
    tracked = iter(
        git_fields(
            [
                "diff",
                "--name-status",
                "--no-renames",
                "-z",
                candidate_sha,
                "--",
                "apps/eqoboard-web",
            ]
        )
    )
    for raw_status in tracked:
        if not raw_status:
            continue
        try:
            raw_path = next(tracked)
        except StopIteration:
            raise RuntimeError("Git returned an incomplete tracked path/status record") from None
        record("tracked", os.fsdecode(raw_status), raw_path)

    for raw_path in git_fields(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", "apps/eqoboard-web"]
    ):
        if raw_path:
            record("untracked", "??", raw_path)
except RuntimeError as error:
    print(f"Native source drift diagnostic failed: {error}.", file=sys.stderr)
    raise SystemExit(2) from None

drift_count = counts["tracked"] + counts["untracked"]
if drift_count == 0:
    raise SystemExit(0)

metadata = {
    "kind": "eqoboard-native-source-drift-diagnostic",
    "schemaVersion": 1,
    "candidateSha": candidate_sha,
    "sourceRoot": "apps/eqoboard-web",
    "trackedChangeCount": counts["tracked"],
    "untrackedPathCount": counts["untracked"],
    "maxListedPaths": MAX_DIAGNOSTIC_PATHS,
    "listedPathCount": listed_path_count,
    "truncated": drift_count > listed_path_count,
    "trackedChanges": listed["tracked"],
    "untrackedPaths": listed["untracked"],
}
try:
    metadata_fd = os.open(
        metadata_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
except OSError:
    print("Could not create the private source drift metadata file under RUNNER_TEMP.", file=sys.stderr)
    raise SystemExit(2) from None
try:
    with os.fdopen(metadata_fd, "w", encoding="utf-8") as metadata_file:
        json.dump(metadata, metadata_file, indent=2, sort_keys=True, ensure_ascii=True)
        metadata_file.write("\n")
except OSError:
    try:
        metadata_path.unlink()
    except OSError:
        pass
    print("Could not write the private source drift metadata file under RUNNER_TEMP.", file=sys.stderr)
    raise SystemExit(2) from None

print(
    f"Native app source differs from NATIVE_CANDIDATE_SHA: "
    f"{counts['tracked']} tracked path(s), {counts['untracked']} untracked path(s).",
    file=sys.stderr,
)
for category in ("tracked", "untracked"):
    for entry in listed[category]:
        print(
            f"  {entry['status']} {json.dumps(entry['path'], ensure_ascii=True)}",
            file=sys.stderr,
        )
if metadata["truncated"]:
    print("Additional source drift paths omitted after the 32-path diagnostic limit.", file=sys.stderr)
print(f"Private source drift metadata: {metadata_path}", file=sys.stderr)
raise SystemExit(2)
PY
# END bounded candidate source drift diagnostic.

if ! command -v syft >/dev/null 2>&1; then
  printf '%s\n' 'Syft must be installed by the pinned native web security workflow.' >&2
  exit 2
fi

# The native lane pins Syft in its workflow. Keep this check here so a changed
# installer cannot silently change the inventory format or cataloger behavior.
expected_syft_version="1.54.1"
actual_syft_version="$(syft version -o json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version", ""))')"
if [[ "$actual_syft_version" != "$expected_syft_version" ]]; then
  printf 'Expected Syft %s, found %s.\n' "$expected_syft_version" "$actual_syft_version" >&2
  exit 1
fi

app_dir="$repo_root/apps/eqoboard-web"
output_dir="${NATIVE_WEB_SBOM_DIR:-$RUNNER_TEMP/native-web-sbom}"
source_sbom="$output_dir/eqoboard-web-source.spdx.json"
image_sbom="$output_dir/eqoboard-web-image.spdx.json"

if [[ ! -f "$app_dir/package-lock.json" ]]; then
  printf '%s\n' 'Native app package-lock.json is required for source SBOM generation.' >&2
  exit 2
fi

candidate_tree="$(git -C "$repo_root" rev-parse "$NATIVE_CANDIDATE_SHA^{tree}")"
candidate_lock_sha256="$(
  git -C "$repo_root" show "$NATIVE_CANDIDATE_SHA:apps/eqoboard-web/package-lock.json" \
    | sha256sum | awk '{print $1}'
)"
if [[ ! "$candidate_tree" =~ ^[0-9a-f]{40}$ || ! "$candidate_lock_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'Could not bind the candidate tree and native package lock.' >&2
  exit 2
fi

actual_image_config_digest="$(docker image inspect "$NATIVE_WEB_IMAGE" --format '{{.Id}}')"
if [[ "$actual_image_config_digest" != "$NATIVE_IMAGE_CONFIG_DIGEST" ]]; then
  printf 'Built image config digest mismatch: expected %s, inspected %s.\n' \
    "$NATIVE_IMAGE_CONFIG_DIGEST" "$actual_image_config_digest" >&2
  exit 1
fi
actual_image_revision="$(docker image inspect "$NATIVE_WEB_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
if [[ "$actual_image_revision" != "$NATIVE_CANDIDATE_SHA" ]]; then
  printf 'Built image revision label does not match candidate %s.\n' "$NATIVE_CANDIDATE_SHA" >&2
  exit 1
fi

mkdir -p "$output_dir"
runner_temp_real="$(cd "$RUNNER_TEMP" && pwd -P)"
output_dir="$(cd "$output_dir" && pwd -P)"
case "$output_dir" in
  "$runner_temp_real"|"$runner_temp_real"/*) ;;
  *)
    printf 'Native SBOM output must stay under RUNNER_TEMP: %s\n' "$output_dir" >&2
    exit 2
    ;;
esac
source_sbom="$output_dir/eqoboard-web-source.spdx.json"
image_sbom="$output_dir/eqoboard-web-image.spdx.json"
identity_receipt="$output_dir/native-image-identity.json"
for artifact_path in "$source_sbom" "$image_sbom" "$identity_receipt" "$output_dir/SHA256SUMS"; do
  if [[ -e "$artifact_path" || -L "$artifact_path" ]]; then
    printf 'Refusing to overwrite an existing native SBOM artifact: %s\n' "$artifact_path" >&2
    exit 2
  fi
done

syft scan "dir:$app_dir" \
  --source-name eqoboard-web \
  --source-version "$NATIVE_CANDIDATE_SHA" \
  --parallelism 1 \
  --override-default-catalogers all \
  --exclude '**/.env*' \
  --exclude '**/.state/**' \
  --exclude '**/node_modules/**' \
  --exclude '**/.next/**' \
  --exclude '**/coverage/**' \
  --exclude '**/test-results/**' \
  --exclude '**/playwright-report/**' \
  --quiet \
  -o "spdx-json=$source_sbom"

syft scan "docker:$NATIVE_IMAGE_CONFIG_DIGEST" \
  --source-name eqoboard-web-image \
  --source-version "$NATIVE_CANDIDATE_SHA" \
  --parallelism 1 \
  --override-default-catalogers all \
  --quiet \
  -o "spdx-json=$image_sbom"

python3 - "$source_sbom" "$image_sbom" <<'PY'
import json
import pathlib
import sys
from urllib.parse import unquote

for raw_path in sys.argv[1:]:
    path = pathlib.Path(raw_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("spdxVersion") != "SPDX-2.3":
        raise SystemExit(f"{path.name}: expected SPDX-2.3")
    packages = data.get("packages")
    if not isinstance(packages, list) or not packages:
        raise SystemExit(f"{path.name}: package inventory is empty or malformed")
    if path.name == "eqoboard-web-image.spdx.json":
        forbidden = []
        for package in packages:
            names = {str(package.get("name", "")).lower()}
            for reference in package.get("externalRefs", []):
                if reference.get("referenceType") == "purl":
                    locator = unquote(str(reference.get("referenceLocator", "")))
                    if locator.startswith("pkg:npm/"):
                        names.add(locator[len("pkg:npm/"):].rsplit("@", 1)[0].lower())
            if any(name in {"sharp", "lightningcss", "libvips", "vips"}
                   or name.startswith(("@img/sharp-", "sharp-libvips-", "lightningcss-", "libvips"))
                   for name in names):
                forbidden.append(package.get("name"))
        if forbidden:
            raise SystemExit(f"runtime optimizer/build-transform packages remain: {forbidden}")
        print("Image SBOM confirms no registered Sharp/libvips/Lightning CSS runtime package")
    print(f"{path.name}: SPDX-2.3, {len(packages)} packages")
PY

python3 - "$NATIVE_CANDIDATE_SHA" "$candidate_tree" "$candidate_lock_sha256" \
  "$NATIVE_WEB_IMAGE" "$NATIVE_IMAGE_CONFIG_DIGEST" "$NATIVE_IMAGE_BUILD_DIGEST" \
  "$actual_image_revision" "$source_sbom" "$image_sbom" "$identity_receipt" <<'PY'
import hashlib
import json
import pathlib
import sys

(candidate_sha, candidate_tree, lock_sha256, image_reference, config_digest,
 build_digest, revision_label, source_path, image_path, receipt_path) = sys.argv[1:]

def artifact(path: str, classification: str) -> dict[str, str]:
    file_path = pathlib.Path(path)
    digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
    return {
        "path": file_path.name,
        "classification": classification,
        "sha256": digest,
    }

receipt = {
    "kind": "eqoboard-native-image-identity",
    "schemaVersion": 1,
    "candidate": {
        "commit": candidate_sha,
        "tree": candidate_tree,
    },
    "source": {
        "appPath": "apps/eqoboard-web",
        "packageLockSha256": lock_sha256,
        "sbom": artifact(source_path, "source-and-lock-inventory"),
    },
    "image": {
        "reference": image_reference,
        "configDigest": config_digest,
        "buildDigest": build_digest,
        "revisionLabel": revision_label,
        "scanReference": f"docker:{config_digest}",
        "sbom": artifact(image_path, "production-runtime-image-inventory"),
    },
    "releaseAcceptance": "NOT_RELEASE",
    "licenseClosure": "NOT_CLAIMED",
}
pathlib.Path(receipt_path).write_text(
    json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY

(
  cd "$output_dir"
  sha256sum "$(basename "$source_sbom")" "$(basename "$image_sbom")" \
    "$(basename "$identity_receipt")" > SHA256SUMS
)

if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    printf '\n### Native web SBOMs\n\n'
    printf 'Candidate: `%s`\n\n' "$NATIVE_CANDIDATE_SHA"
    printf 'Source/lock and production-image SPDX 2.3 inventories are in `%s`.\n' "$output_dir"
    printf 'The runtime image scan used config digest `%s`; build output digest is `%s`.\n' \
      "$NATIVE_IMAGE_CONFIG_DIGEST" "$NATIVE_IMAGE_BUILD_DIGEST"
    printf 'Identity receipt is candidate-bound and reports `NOT_RELEASE`; SBOMs do not claim license closure.\n'
    printf '\n```text\n'
    cat "$output_dir/SHA256SUMS"
    printf '```\n'
  } >> "$GITHUB_STEP_SUMMARY"
fi
