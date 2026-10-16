#!/usr/bin/env bash
set -Eeuo pipefail

# Run the native-app source/history secret scan and verify the scanner's
# path-scoped public-series exception against a generated non-secret control.
# This helper is Actions-only and never writes into the checkout.
if [[ ${GITHUB_ACTIONS:-} != true ]]; then
  printf '%s\n' 'Native web secret scanning must run in GitHub Actions.' >&2
  exit 2
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${NATIVE_CANDIDATE_SHA:?NATIVE_CANDIDATE_SHA must identify the checked-out candidate commit}"

if [[ ! "$NATIVE_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' 'NATIVE_CANDIDATE_SHA must be a full lowercase 40-character commit SHA.' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if ! checkout_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null)"; then
  printf 'Could not resolve the checked-out candidate commit in %s.\n' "$repo_root" >&2
  exit 2
fi
if [[ ! "$checkout_sha" =~ ^[0-9a-f]{40}$ || "$checkout_sha" != "$NATIVE_CANDIDATE_SHA" ]]; then
  printf 'NATIVE_CANDIDATE_SHA (%s) does not match checked-out HEAD (%s).\n' \
    "$NATIVE_CANDIDATE_SHA" "$checkout_sha" >&2
  exit 2
fi

if [[ ! -f "$repo_root/tools/ci/native-gitleaks.toml" ]]; then
  printf '%s\n' 'The reviewed native Gitleaks configuration is required.' >&2
  exit 2
fi

readonly GITLEAKS_IMAGE='ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb'
readonly GITLEAKS_CONFIG='/repo/tools/ci/native-gitleaks.toml'
app_dir="$repo_root/apps/eqoboard-web"
if [[ ! -d "$app_dir" ]]; then
  printf 'Native web source directory is missing: %s\n' "$app_dir" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker must be available in the GitHub Actions runner.' >&2
  exit 2
fi
if [[ "$(uname -m)" != 'x86_64' ]]; then
  printf '%s\n' 'The pinned Gitleaks image digest is for the linux/amd64 Actions runner.' >&2
  exit 2
fi

if [[ ! -d "$RUNNER_TEMP" ]]; then
  printf 'RUNNER_TEMP is not a directory: %s\n' "$RUNNER_TEMP" >&2
  exit 2
fi
runner_temp_real="$(cd "$RUNNER_TEMP" && pwd -P)"
work_root="$(mktemp -d "$runner_temp_real/native-web-secret-scan.XXXXXX")"
chmod 700 "$work_root"
cleanup() {
  if [[ -n "${work_root:-}" && -d "$work_root" ]]; then
    rm -rf -- "$work_root"
  fi
}
trap cleanup EXIT

fixture_root="$work_root/fixture"
fixture_path="$fixture_root/apps/eqoboard-web/lib/server/research/macro.ts"
wrong_fixture_root="$work_root/wrong-fixture"
wrong_fixture_path="$wrong_fixture_root/apps/eqoboard-web/lib/server/research/macro-copy.ts"
mkdir -p "$(dirname "$fixture_path")"
mkdir -p "$(dirname "$wrong_fixture_path")"
write_public_series_fixture() {
  python3 - "$1" <<'PY'
import sys

series = ".".join(("B", "U2", "EUR", "4F", "G_N_A", "SV_C_YM", "SR_3M"))
with open(sys.argv[1], "w", encoding="utf-8") as fixture:
    fixture.write("// Public ECB SDMX series identifier in a generated scanner control.\n")
    fixture.write(f'export const publicYieldSeries = {{ api_key: "{series}" }};\n')
PY
}
write_public_series_fixture "$fixture_path"
write_public_series_fixture "$wrong_fixture_path"

scan_uid="$(id -u)"
scan_gid="$(id -g)"
if [[ ! "$scan_uid" =~ ^[0-9]+$ || ! "$scan_gid" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'Could not determine the numeric runner UID/GID for the read-only scanner container.' >&2
  exit 2
fi

# The public identifier must remain accepted only at its exact macro source
# path. Capture self-check output inside the private temp directory so neither
# expected findings nor accidental scanner output can be uploaded or logged.
positive_log="$work_root/positive.log"
wrong_path_log="$work_root/wrong-path.log"
negative_log="$work_root/negative.log"
if docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user "$scan_uid:$scan_gid" \
  --volume "$repo_root:/repo:ro" --volume "$fixture_root:/probe:ro" \
  --workdir /repo "$GITLEAKS_IMAGE" dir \
  --config "$GITLEAKS_CONFIG" --redact --verbose --no-banner /probe \
  > "$positive_log" 2>&1; then
  positive_status=0
else
  positive_status=$?
fi
if (( positive_status != 0 )); then
  printf 'Gitleaks rejected the public-series control fixture (exit %s).\n' "$positive_status" >&2
  exit 1
fi

# The same public value in any other source path must not inherit the exception.
if docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user "$scan_uid:$scan_gid" \
  --volume "$repo_root:/repo:ro" --volume "$wrong_fixture_root:/probe:ro" \
  --workdir /repo "$GITLEAKS_IMAGE" dir \
  --config "$GITLEAKS_CONFIG" --redact --verbose --no-banner /probe \
  > "$wrong_path_log" 2>&1; then
  wrong_path_status=0
else
  wrong_path_status=$?
fi
if (( wrong_path_status != 1 )) || ! grep -qi 'generic-api-key' "$wrong_path_log"; then
  printf 'Gitleaks did not reject the public-series control outside its exact allowlisted path (exit %s).\n' \
    "$wrong_path_status" >&2
  exit 1
fi

# Generate a balanced synthetic control. Unrestricted random text can contain
# a default generic-rule stopword or fall below its entropy threshold. The
# pinned rule's only stopwords over digits/Q/X are six zeros or six Xs; four
# copies of each of twelve symbols cannot contain either, and entropy is
# log2(12) > 3.5. The scanner policy itself remains unchanged.
# The value is never printed, committed, included in a report, or uploaded.
python3 - "$fixture_path" <<'PY'
import secrets
import string
import sys

alphabet = string.digits + "QX"
characters = list(alphabet * 4)
secrets.SystemRandom().shuffle(characters)
candidate = "".join(characters)
with open(sys.argv[1], "a", encoding="utf-8") as fixture:
    fixture.write(f'\nexport const scannerControl = {{ api_key: "{candidate}" }};\n')
PY

if docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user "$scan_uid:$scan_gid" \
  --volume "$repo_root:/repo:ro" --volume "$fixture_root:/probe:ro" \
  --workdir /repo "$GITLEAKS_IMAGE" dir \
  --config "$GITLEAKS_CONFIG" --redact --verbose --no-banner /probe \
  > "$negative_log" 2>&1; then
  negative_status=0
else
  negative_status=$?
fi
if (( negative_status != 1 )) || ! grep -qi 'generic-api-key' "$negative_log"; then
  printf 'Gitleaks did not reject the generated generic API-key control (exit %s).\n' \
    "$negative_status" >&2
  exit 1
fi

# Remove only the fresh private self-check directory before scanning the
# candidate itself. Its trap remains as cleanup for every failure path.
rm -rf -- "$work_root"

base_sha="${BASE_SHA:-}"
if [[ -z "$base_sha" || "$base_sha" =~ ^0{40}$ ]]; then
  scan_range='--all'
else
  if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' 'BASE_SHA must be empty or a full lowercase 40-character commit SHA.' >&2
    exit 2
  fi
  if ! git -C "$repo_root" cat-file -e "$base_sha^{commit}" 2>/dev/null; then
    printf 'BASE_SHA is not present in the candidate checkout: %s\n' "$base_sha" >&2
    exit 2
  fi
  scan_range="$base_sha..$NATIVE_CANDIDATE_SHA"
fi

# Scan the native app source tree and the exact candidate commit range. Both
# containers are networkless, read-only, capability-free and run as the runner
# UID so Git never needs a global safe.directory exception.
docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user "$scan_uid:$scan_gid" \
  --volume "$repo_root:/repo:ro" --workdir /repo \
  "$GITLEAKS_IMAGE" dir --config "$GITLEAKS_CONFIG" \
  --redact --verbose --no-banner /repo/apps/eqoboard-web

docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user "$scan_uid:$scan_gid" \
  --volume "$repo_root:/repo:ro" --workdir /repo \
  "$GITLEAKS_IMAGE" git --config "$GITLEAKS_CONFIG" \
  --redact --verbose --no-banner --log-opts="$scan_range" .

printf 'Native secret scan passed for candidate %s (range %s).\n' \
  "$NATIVE_CANDIDATE_SHA" "$scan_range"
