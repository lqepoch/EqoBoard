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
if ! git -C "$repo_root" diff --quiet "$NATIVE_CANDIDATE_SHA" -- apps/eqoboard-web; then
  printf '%s\n' 'Native app source differs from NATIVE_CANDIDATE_SHA.' >&2
  exit 2
fi
if [[ -n "$(git -C "$repo_root" ls-files --others --exclude-standard -- apps/eqoboard-web)" ]]; then
  printf '%s\n' 'Untracked native app source cannot be included in the candidate SBOM.' >&2
  exit 2
fi

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
