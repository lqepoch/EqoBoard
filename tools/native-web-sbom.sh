#!/usr/bin/env bash
set -Eeuo pipefail

# Emit both the native app source/lock SBOM and the exact production image SBOM
# for this candidate. Output is kept under RUNNER_TEMP, outside the build context.
if [[ ${GITHUB_ACTIONS:-} != true ]]; then
  printf '%s\n' 'Native web SBOM generation must run in GitHub Actions.' >&2
  exit 2
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${NATIVE_CANDIDATE_SHA:?NATIVE_CANDIDATE_SHA must identify the checked-out candidate commit}"
: "${NATIVE_WEB_IMAGE:?NATIVE_WEB_IMAGE must identify the production image}"

if [[ ! "$NATIVE_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'NATIVE_CANDIDATE_SHA must be a full lowercase commit SHA; got: %s\n' "$NATIVE_CANDIDATE_SHA" >&2
  exit 2
fi

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
rm -f "$source_sbom" "$image_sbom"

syft scan "dir:$app_dir" \
  --source-name eqoboard-web \
  --source-version "$NATIVE_CANDIDATE_SHA" \
  --parallelism 1 \
  --override-default-catalogers all \
  --exclude '**/node_modules/**' \
  --exclude '**/.next/**' \
  --exclude '**/coverage/**' \
  --exclude '**/test-results/**' \
  --exclude '**/playwright-report/**' \
  --quiet \
  -o "spdx-json=$source_sbom"

syft scan "docker:$NATIVE_WEB_IMAGE" \
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

for raw_path in sys.argv[1:]:
    path = pathlib.Path(raw_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("spdxVersion") != "SPDX-2.3":
        raise SystemExit(f"{path.name}: expected SPDX-2.3")
    packages = data.get("packages")
    if not isinstance(packages, list) or not packages:
        raise SystemExit(f"{path.name}: package inventory is empty or malformed")
    print(f"{path.name}: SPDX-2.3, {len(packages)} packages")
PY

(
  cd "$output_dir"
  sha256sum "$(basename "$source_sbom")" "$(basename "$image_sbom")" > SHA256SUMS
)

if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    printf '\n### Native web SBOMs\n\n'
    printf 'Candidate: `%s`\n\n' "$NATIVE_CANDIDATE_SHA"
    printf 'Source/lock and production-image SPDX 2.3 inventories are in `%s`.\n' "$output_dir"
    printf '\n```text\n'
    cat "$output_dir/SHA256SUMS"
    printf '```\n'
  } >> "$GITHUB_STEP_SUMMARY"
fi
