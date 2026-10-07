#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${EQO_OPENBB_LITE_RELEASE_IMAGE:-}"

usage() {
  cat <<'EOF'
Usage:
  EQO_OPENBB_LITE_RELEASE_IMAGE=eqoboard/openbb-workspace-lite@sha256:<64-hex-digest> \
    tools/openbb/openbb-release-compose.sh up [docker compose up options...]

Pulls the exact repository digest, verifies Docker reports that same RepoDigest,
then starts the OpenBB Compose profile without a build section.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ ! "${IMAGE}" =~ ^eqoboard/openbb-workspace-lite@sha256:[0-9a-f]{64}$ ]]; then
  printf 'EQO_OPENBB_LITE_RELEASE_IMAGE must be the approved OpenBB Lite repository@sha256 digest\n' >&2
  usage >&2
  exit 2
fi
if [[ $# -gt 0 && "$1" != "up" ]]; then
  printf 'Only the verified release up operation is supported\n' >&2
  usage >&2
  exit 2
fi
if [[ $# -gt 0 ]]; then shift; fi
if [[ $# -eq 0 ]]; then set -- --detach --wait; fi

compose=(docker compose --profile openbb -f "${ROOT_DIR}/compose.yaml" -f "${ROOT_DIR}/compose.openbb.release.yaml")
export EQO_OPENBB_LITE_RELEASE_IMAGE="${IMAGE}"
"${compose[@]}" pull openbb-lite
reported_digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${IMAGE}")"
if ! grep -Fxq "${IMAGE}" <<<"${reported_digests}"; then
  printf 'Docker did not report the requested repository digest after pull\n' >&2
  exit 1
fi
"${compose[@]}" up "$@"
