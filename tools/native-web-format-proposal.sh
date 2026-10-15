#!/usr/bin/env bash
set -Eeuo pipefail

# Produce a review-only Biome formatting patch from an exact candidate archive.
# The checked-out repository is never formatted or staged by this helper.
if [[ ${GITHUB_ACTIONS:-} != true ]]; then
  printf '%s\n' 'Native web format proposals may only be generated in GitHub Actions.' >&2
  exit 2
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${NATIVE_CANDIDATE_SHA:?NATIVE_CANDIDATE_SHA must identify the checked-out candidate commit}"
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

app_dir="$repo_root/apps/eqoboard-web"
lockfile="$app_dir/package-lock.json"
biome_bin="$app_dir/node_modules/.bin/biome"
if [[ ! -f "$lockfile" || ! -x "$biome_bin" ]]; then
  printf '%s\n' 'The locked native Biome binary must be installed by npm ci before proposal generation.' >&2
  exit 2
fi

locked_biome_version="$(node - "$lockfile" <<'NODE'
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const declared = lock.packages?.[""]?.devDependencies?.["@biomejs/biome"];
const resolved = lock.packages?.["node_modules/@biomejs/biome"]?.version;
if (typeof declared !== "string" || declared !== resolved || !/^\d+\.\d+\.\d+$/.test(resolved)) {
  process.exit(2);
}
process.stdout.write(resolved);
NODE
)"
installed_biome_version="$(node - "$app_dir/node_modules/@biomejs/biome/package.json" <<'NODE'
const fs = require("node:fs");
const installed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof installed.version !== "string") process.exit(2);
process.stdout.write(installed.version);
NODE
)"
if [[ "$locked_biome_version" != "$installed_biome_version" ]]; then
  printf 'Installed Biome %s does not match package-lock.json version %s.\n' \
    "$installed_biome_version" "$locked_biome_version" >&2
  exit 2
fi

runner_temp_real="$(cd "$RUNNER_TEMP" && pwd -P)"
proposal_dir="$runner_temp_real/native-format-proposal"
if [[ -e "$proposal_dir" ]]; then
  printf 'Refusing to overwrite existing proposal output: %s\n' "$proposal_dir" >&2
  exit 2
fi
work_root="$(mktemp -d "$runner_temp_real/native-web-format-work.XXXXXX")"
cleanup() {
  rm -rf -- "$work_root"
}
trap cleanup EXIT

source_root="$work_root/source"
archive_app_dir="$source_root/apps/eqoboard-web"
archive_path="$work_root/candidate-source.tar"
patch_tmp="$work_root/format.patch"
metadata_tmp="$work_root/metadata.json"
mkdir -p "$source_root" "$work_root/home"

git -C "$repo_root" archive --format=tar "$NATIVE_CANDIDATE_SHA" -- apps/eqoboard-web > "$archive_path"
archive_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
tar -xf "$archive_path" -C "$source_root"
if [[ ! -d "$archive_app_dir" ]]; then
  printf '%s\n' 'The candidate archive did not contain apps/eqoboard-web.' >&2
  exit 2
fi

git -c init.defaultBranch=proposal-baseline init --quiet "$source_root"
git -C "$source_root" config core.autocrlf false
git -C "$source_root" config core.hooksPath /dev/null
git -C "$source_root" add -- apps/eqoboard-web
git -C "$source_root" -c user.name='Native format proposal' \
  -c user.email='native-format-proposal@invalid' \
  commit --quiet -m 'Formatting proposal baseline'

format_exit_code=0
(
  cd "$archive_app_dir"
  env -i \
    PATH="$PATH" \
    HOME="$work_root/home" \
    TMPDIR="$runner_temp_real" \
    LANG="${LANG:-C.UTF-8}" \
    LC_ALL="${LC_ALL:-C.UTF-8}" \
    TZ=UTC \
    CI=true \
    "$biome_bin" format --write .
) || format_exit_code=$?

git -C "$source_root" add -A -- apps/eqoboard-web
git -C "$source_root" diff --cached --binary --no-ext-diff --no-renames HEAD -- apps/eqoboard-web > "$patch_tmp"
patch_bytes="$(wc -c < "$patch_tmp" | tr -d '[:space:]')"
patch_sha256="$(sha256sum "$patch_tmp" | awk '{print $1}')"
max_output_bytes=8388608
patch_included=true
patch_omission_reason=""

write_metadata() {
  python3 - "$metadata_tmp" "$NATIVE_CANDIDATE_SHA" "$checkout_sha" \
    "$locked_biome_version" "$format_exit_code" "$archive_sha256" \
    "$patch_bytes" "$patch_sha256" "$patch_included" "$patch_omission_reason" \
    "$max_output_bytes" <<'PY'
import json
import pathlib
import sys

(metadata_path, candidate, checkout, biome, formatter_exit, archive_sha, patch_bytes,
 patch_sha, patch_included, omission_reason, limit) = sys.argv[1:]
metadata = {
    "kind": "native-web-biome-format-proposal",
    "candidate_sha": candidate,
    "checked_out_head": checkout,
    "acceptance": "NOT_ACCEPTANCE",
    "source_checks": "unchanged; CI lint/format results remain authoritative",
    "formatter": {
        "package": "@biomejs/biome",
        "version": biome,
        "command": "biome format --write .",
        "exit_code": int(formatter_exit),
    },
    "source_archive": {"path": "apps/eqoboard-web", "sha256": archive_sha},
    "proposal": {
        "path": "format.patch" if patch_included == "true" else None,
        "format": "git-apply unified diff",
        "sha256": patch_sha,
        "bytes": int(patch_bytes),
        "included": patch_included == "true",
        "omission_reason": omission_reason or None,
        "output_limit_bytes": int(limit),
    },
}
pathlib.Path(metadata_path).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
PY
}

write_metadata
metadata_bytes="$(wc -c < "$metadata_tmp" | tr -d '[:space:]')"
patch_copy=""
if (( patch_bytes + metadata_bytes > max_output_bytes )); then
  patch_included=false
  patch_omission_reason='combined patch and metadata exceed the 8 MiB output limit'
  write_metadata
  metadata_bytes="$(wc -c < "$metadata_tmp" | tr -d '[:space:]')"
  if (( metadata_bytes > max_output_bytes )); then
    printf '%s\n' 'Format proposal metadata unexpectedly exceeds the 8 MiB output limit.' >&2
    exit 2
  fi
else
  patch_copy="$work_root/format.patch.copy"
  cp -- "$patch_tmp" "$patch_copy"
fi

mkdir -m 700 "$proposal_dir"
if [[ -n "$patch_copy" ]]; then
  cp -- "$patch_copy" "$proposal_dir/format.patch"
fi
cp -- "$metadata_tmp" "$proposal_dir/metadata.json"

printf 'Native format proposal: %s (candidate %s, formatter exit %s, patch %s bytes).\n' \
  "$proposal_dir" "$NATIVE_CANDIDATE_SHA" "$format_exit_code" "$patch_bytes"
