#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_PATH="${PATH}"
TASK_HOME="${HOME:-/tmp}"
DOCKER_CONFIG_DIR="${DOCKER_CONFIG:-${TASK_HOME}/.docker}"
PROJECT_NAME="eqoboard-openbb-e2e-$$"
ARTIFACT_DIR="${OPENBB_E2E_ARTIFACT_DIR:-/root/.codex/artifacts/eqoboard-openbb-20261007/runtime/${PROJECT_NAME}}"
LITE_IMAGE="eqoboard/openbb-workspace-lite:${PROJECT_NAME}-lite"
ENV_FILE=""
STATE_FILE=""
MAIN_STATE_FILE=""
PLAYWRIGHT_REPORT_FILE=""
ROLLBACK_TAG_MUTATED=0
LITE_IMAGE_ID=""
BROKEN_UPGRADE_IMAGE_ID=""
COMPOSE_PATH="${ROOT_DIR}/compose.openbb.e2e.yaml"
IMAGE_ARCHIVE="${ARTIFACT_DIR}/openbb-lite-compose-image.docker.tar"
RUN_LOG="${ARTIFACT_DIR}/runtime-e2e.log"

if [[ -d "${ARTIFACT_DIR}" ]]; then
  existing_evidence="$(find "${ARTIFACT_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)"
  if [[ -e "${ARTIFACT_DIR}/runtime-result.json" || -n "${existing_evidence}" ]]; then
    printf 'Refusing to reuse non-empty OpenBB E2E artifact directory: %s\n' "${ARTIFACT_DIR}" >&2
    exit 2
  fi
fi

mkdir -p "${ARTIFACT_DIR}"
chmod 700 "${ARTIFACT_DIR}"
umask 077
ENV_FILE="$(mktemp /tmp/eqoboard-openbb-e2e-env.XXXXXX)"

compose() {
  env -i \
    PATH="${TASK_PATH}" HOME="${TASK_HOME}" DOCKER_CONFIG="${DOCKER_CONFIG_DIR}" \
    docker compose --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" "$@"
}

compose_e2e() {
  compose --profile openbb -f "${ROOT_DIR}/compose.yaml" -f "${COMPOSE_PATH}" "$@"
}

log_phase() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "${RUN_LOG}"
}

run_logged() {
  local label="$1"
  local logfile="$2"
  shift 2
  log_phase "${label}"
  if ! "$@" >"${logfile}" 2>&1; then
    printf '%s failed; last output follows:\n' "${label}" | tee -a "${RUN_LOG}"
    tail -n 100 "${logfile}" | tee -a "${RUN_LOG}"
    return 1
  fi
}

assert_health() {
  local service="$1"
  local container_id status
  container_id="$(compose_e2e ps -q "${service}")"
  test -n "${container_id}"
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"
  test "${status}" = healthy
  printf '%s=%s\n' "${service}" "${status}" | tee -a "${RUN_LOG}"
}

cleanup() {
  local status=$?
  local down_status cleanup_failed=0 remaining_containers remaining_volumes remaining_networks restored_image_id restore_status raw_logs compose_log_path compose_logs_status sanitizer_status raw_logs_remove_status
  set +e
  if [[ ${status} -ne 0 ]]; then
    compose_e2e ps --all >"${ARTIFACT_DIR}/compose-failure-ps.txt" 2>&1
    compose_log_path="${ARTIFACT_DIR}/compose-failure-logs.txt"
  else
    compose_log_path="${ARTIFACT_DIR}/compose-final-logs.txt"
  fi
  raw_logs="$(mktemp /tmp/eqoboard-openbb-compose-logs.XXXXXX)"
  compose_e2e logs --no-color --tail=300 >"${raw_logs}" 2>&1
  compose_logs_status=$?
  node "${ROOT_DIR}/tools/openbb-sanitize-e2e-logs.mjs" "${raw_logs}" "${compose_log_path}" "${ENV_FILE}"
  sanitizer_status=$?
  if [[ ${compose_logs_status} -ne 0 || ${sanitizer_status} -ne 0 ]]; then
    cleanup_failed=1
    printf 'compose_logs_exit=%s\ncompose_log_sanitizer_exit=%s\n' \
      "${compose_logs_status}" "${sanitizer_status}" >>"${ARTIFACT_DIR}/cleanup-residuals.txt"
  fi
  rm -f "${raw_logs}"
  raw_logs_remove_status=$?
  if [[ ${raw_logs_remove_status} -ne 0 || -e "${raw_logs}" ]]; then
    cleanup_failed=1
    printf 'raw compose log temporary file could not be removed\n' >>"${ARTIFACT_DIR}/cleanup-residuals.txt"
  fi
  compose_e2e down --volumes --remove-orphans >>"${RUN_LOG}" 2>&1
  down_status=$?
  remaining_containers="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
  remaining_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
  remaining_networks="$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
  if [[ ${down_status} -ne 0 || -n "${remaining_containers}" || -n "${remaining_volumes}" || -n "${remaining_networks}" ]]; then
    cleanup_failed=1
    {
      printf 'compose_down_exit=%s\n' "${down_status}"
      printf 'remaining_container_ids=%s\n' "${remaining_containers}"
      printf 'remaining_volume_names=%s\n' "${remaining_volumes}"
      printf 'remaining_network_ids=%s\n' "${remaining_networks}"
    } >"${ARTIFACT_DIR}/cleanup-residuals.txt"
  fi
  if [[ ${ROLLBACK_TAG_MUTATED} -eq 1 && -f "${IMAGE_ARCHIVE}" && -n "${LITE_IMAGE_ID}" ]]; then
    docker load -i "${IMAGE_ARCHIVE}" >"${ARTIFACT_DIR}/cleanup-image-restore.log" 2>&1
    restore_status=$?
    restored_image_id="$(docker image inspect --format '{{.Id}}' "${LITE_IMAGE}" 2>/dev/null)"
    if [[ ${restore_status} -eq 0 && "${restored_image_id}" == "${LITE_IMAGE_ID}" ]]; then
      ROLLBACK_TAG_MUTATED=0
      printf 'restored_image_id=%s\n' "${restored_image_id}" >>"${ARTIFACT_DIR}/cleanup-image-restore.log"
    else
      cleanup_failed=1
      printf 'docker_load_exit=%s\nexpected_image_id=%s\nactual_image_id=%s\n' \
        "${restore_status}" "${LITE_IMAGE_ID}" "${restored_image_id}" >>"${ARTIFACT_DIR}/cleanup-image-restore.log"
    fi
  elif [[ ${ROLLBACK_TAG_MUTATED} -eq 1 ]]; then
    cleanup_failed=1
    printf 'rollback tag was mutated but its saved image archive or original image id is missing\n' \
      >"${ARTIFACT_DIR}/cleanup-image-restore.log"
  fi
  if [[ -n "${PLAYWRIGHT_REPORT_FILE}" && -s "${PLAYWRIGHT_REPORT_FILE}" ]]; then
    if ! node "${ROOT_DIR}/tools/openbb-sanitize-e2e-logs.mjs" \
      "${PLAYWRIGHT_REPORT_FILE}" "${ARTIFACT_DIR}/openbb-lite-playwright.json" "${ENV_FILE}"; then
      cleanup_failed=1
      printf 'Playwright JSON report sanitization failed\n' >>"${ARTIFACT_DIR}/cleanup-residuals.txt"
    fi
  fi
  if [[ -n "${PLAYWRIGHT_REPORT_FILE}" && -f "${PLAYWRIGHT_REPORT_FILE}" ]]; then rm -f "${PLAYWRIGHT_REPORT_FILE}"; fi
  for browser_log in "${ARTIFACT_DIR}"/playwright-*.log "${RUN_LOG}"; do
    if [[ -f "${browser_log}" ]] && ! node "${ROOT_DIR}/tools/openbb-sanitize-e2e-logs.mjs" \
      "${browser_log}" "${browser_log}" "${ENV_FILE}"; then
      cleanup_failed=1
      printf 'Browser/runtime log sanitization failed: %s\n' "${browser_log}" >>"${ARTIFACT_DIR}/cleanup-residuals.txt"
    fi
  done
  if [[ -n "${ENV_FILE}" && -f "${ENV_FILE}" ]]; then rm -f "${ENV_FILE}"; fi
  if [[ -n "${STATE_FILE}" && -f "${STATE_FILE}" ]]; then rm -f "${STATE_FILE}"; fi
  if [[ -n "${MAIN_STATE_FILE}" && -f "${MAIN_STATE_FILE}" ]]; then rm -f "${MAIN_STATE_FILE}"; fi
  if [[ ( -n "${ENV_FILE}" && -e "${ENV_FILE}" ) || ( -n "${STATE_FILE}" && -e "${STATE_FILE}" ) || ( -n "${MAIN_STATE_FILE}" && -e "${MAIN_STATE_FILE}" ) || ( -n "${PLAYWRIGHT_REPORT_FILE}" && -e "${PLAYWRIGHT_REPORT_FILE}" ) ]]; then
    cleanup_failed=1
    printf 'temporary credentials/state files remain after cleanup\n' >>"${ARTIFACT_DIR}/cleanup-residuals.txt"
  fi
  {
    printf 'compose_down_exit=%s\n' "${down_status}"
    printf 'remaining_container_ids=%s\n' "${remaining_containers}"
    printf 'remaining_volume_names=%s\n' "${remaining_volumes}"
    printf 'remaining_network_ids=%s\n' "${remaining_networks}"
    printf 'cleanup_verified=%s\n' "$([[ ${cleanup_failed} -eq 0 ]] && printf true || printf false)"
  } >"${ARTIFACT_DIR}/cleanup-result.txt"
  if [[ ${status} -eq 0 && ${cleanup_failed} -eq 0 ]]; then
    if cat >"${ARTIFACT_DIR}/runtime-result.json" <<EOF
{
  "result": "passed",
  "cleanup_verified": true,
  "frozen_git_head": "${GIT_HEAD}",
  "upstream_commits": {
    "OpenTerminal": "${OPENTERMINAL_SOURCE_COMMIT}",
    "OpenBB Workspace": "${OPENBB_SOURCE_COMMIT}"
  },
  "openbb_source_archive_sha256": "${OPENBB_SOURCE_ARCHIVE_SHA256}",
  "openbb_community_build_identity": "${OPENBB_BUILD_IDENTITY}",
  "default_profile_smoke_executed": ${DEFAULT_PROFILE_SMOKE_EXECUTED},
  "compose_project": "${PROJECT_NAME}",
  "lite_image": "${LITE_IMAGE}",
  "docker_image_id_observation": "${LITE_IMAGE_ID}",
  "docker_daemon_repo_digest_observation": "$(cat "${ARTIFACT_DIR}/openbb-lite-compose-image-repodigest.txt")",
  "artifact_identity_note": "The Compose local build is identified by its recipe inputs and saved Docker archive SHA. OCI index, application manifest, config, and layer descriptors are reported separately when the daemon archive provides them; no registry publication is implied.",
  "image_archive": "${IMAGE_ARCHIVE}",
  "image_archive_sha256": "$(cut -d ' ' -f 1 "${ARTIFACT_DIR}/openbb-lite-compose-image.docker.tar.sha256")",
  "image_archive_manifest_evidence": "openbb-lite-compose-archive-manifest.json",
  "rollback_image_id": "${BROKEN_UPGRADE_IMAGE_ID}",
  "browser_evidence": [
    "native-openbb-mock-dashboard-market-time.png",
    "native-openbb-mock-dashboard-source-feed.png",
    "native-openbb-mock-dashboard-completeness.png",
    "native-openbb-pagination-error.png",
    "native-openbb-market-entitlement-denied.png",
    "research-role-denied.png",
    "native-openbb-gateway-offline.png",
    "native-openbb-gateway-restarted.png",
    "native-terminal-openbb-stopped.png",
    "native-openbb-rollback-restored.png"
  ],
  "execution_enabled": false,
  "alpaca_fixture_source_label": "unknown",
  "feeds": ["sip", "opra"]
}
EOF
    then
      log_phase "PASS: scoped OpenBB E2E project stopped and its disposable volumes removed"
    else
      cleanup_failed=1
      status=1
      rm -f "${ARTIFACT_DIR}/runtime-result.json"
      log_phase "FAIL: cleanup was verified, but the final runtime result could not be recorded"
    fi
  else
    if [[ ${cleanup_failed} -ne 0 && ${status} -eq 0 ]]; then status=1; fi
    if [[ ${cleanup_failed} -ne 0 ]]; then
      log_phase "FAIL: scoped OpenBB E2E cleanup did not verify clean; see cleanup-result.txt, cleanup-residuals.txt, and compose-failure artifacts"
    else
      log_phase "PASS: scoped OpenBB E2E cleanup verified clean after failed test run"
    fi
  fi
  exit "${status}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"
: >"${RUN_LOG}"
GIT_HEAD="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Refusing to run OpenBB E2E against a dirty source tree\n' >&2
  exit 2
fi
IFS=$'\t' read -r OPENTERMINAL_SOURCE_COMMIT OPENBB_SOURCE_COMMIT OPENBB_SOURCE_ARCHIVE_SHA256 OPENBB_BUILD_IDENTITY \
  < <(python3 -B - <<'PY'
import sys
sys.path.insert(0, "tools/openbb")
import openbb_upstream as upstream

lock = upstream.read_json(upstream.UPSTREAM_LOCK)
terminal = next(source for source in lock["sources"] if source["name"] == "OpenTerminal")
openbb = upstream.openbb_entry()
identity = upstream.locked_recipe(openbb)[3]
print("\t".join((terminal["commit"], openbb["commit"], openbb["source_archive"]["sha256"], identity)))
PY
)
DEFAULT_PROFILE_SMOKE_EXECUTED=true
if [[ "${OPENBB_E2E_SKIP_DEFAULT_PROFILE_SMOKE:-0}" == "1" ]]; then
  DEFAULT_PROFILE_SMOKE_EXECUTED=false
fi
if [[ -z "${OPENBB_BUILD_IDENTITY}" || "${#OPENBB_BUILD_IDENTITY}" -ne 64 ]]; then
  printf 'Could not derive a valid lock-pinned OpenBB build identity\n' >&2
  exit 2
fi
log_phase "Frozen HEAD=${GIT_HEAD}; OpenTerminal=${OPENTERMINAL_SOURCE_COMMIT}; OpenBB=${OPENBB_SOURCE_COMMIT}; build_identity=${OPENBB_BUILD_IDENTITY}; default_profile_smoke=${DEFAULT_PROFILE_SMOKE_EXECUTED}"

# The Compose env file below contains disposable test values only. Remove any
# operator secrets inherited by this shell before invoking host test tools.
unset ALPACA_KEY ALPACA_SECRET EQO_GATEWAY_JWT_SECRET EQO_RESEARCH_JWT_SECRET \
  EQO_RESEARCH_API_KEY NEXTAUTH_SECRET EQO_OPENBB_NEXTAUTH_SECRET \
  EQO_OIDC_CLIENT_SECRET EQO_OPENBB_OIDC_CLIENT_SECRET OPENBB_ADMIN_PASSWORD

mapfile -t PORTS < <(node --input-type=module -e '
  import net from "node:net";
  const servers = Array.from({ length: 6 }, () => net.createServer());
  const ports = [];
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { ports.push(server.address().port); resolve(); });
  })));
  console.log(ports.join("\n"));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
')
if [[ ${#PORTS[@]} -ne 6 ]]; then
  echo "Could not allocate the six isolated loopback ports" >&2
  exit 1
fi

GATEWAY_PORT="${PORTS[0]}"
TERMINAL_PORT="${PORTS[1]}"
RESEARCH_PORT="${PORTS[2]}"
MAIN_OIDC_PORT="${PORTS[3]}"
RESEARCH_OIDC_PORT="${PORTS[4]}"
ALPACA_PORT="${PORTS[5]}"
MAIN_ORIGIN="http://localhost:${TERMINAL_PORT}"
RESEARCH_ORIGIN="http://127.0.0.1:${RESEARCH_PORT}"
ALPACA_ORIGIN="http://127.0.0.1:${ALPACA_PORT}"
ADMIN_EMAIL="openbb-e2e@example.com"
ADMIN_PASSWORD="Openbb-e2e-$(openssl rand -hex 18)"
CONTROL_TOKEN="$(openssl rand -hex 24)"
MAIN_OIDC_CONTROL_TOKEN="$(openssl rand -hex 24)"
RESEARCH_OIDC_CONTROL_TOKEN="$(openssl rand -hex 24)"

GATEWAY_JWT_SECRET="$(openssl rand -hex 32)"
RESEARCH_JWT_SECRET="$(openssl rand -hex 32)"
MAIN_NEXTAUTH_SECRET="$(openssl rand -hex 32)"
RESEARCH_NEXTAUTH_SECRET="$(openssl rand -hex 32)"
RESEARCH_API_KEY="$(openssl rand -hex 32)"
MAIN_OIDC_SECRET="$(openssl rand -hex 24)"
RESEARCH_OIDC_SECRET="$(openssl rand -hex 24)"
STATE_FILE="$(mktemp /tmp/eqoboard-openbb-runtime-state.XXXXXX)"
MAIN_STATE_FILE="$(mktemp /tmp/eqoboard-openbb-main-state.XXXXXX)"
PLAYWRIGHT_REPORT_FILE="$(mktemp /tmp/eqoboard-openbb-playwright-report.XXXXXX)"
chmod 600 "${STATE_FILE}" "${MAIN_STATE_FILE}" "${PLAYWRIGHT_REPORT_FILE}"

cat >"${ENV_FILE}" <<EOF
EQO_GATEWAY_HOST_PORT=${GATEWAY_PORT}
EQO_TERMINAL_HOST_PORT=${TERMINAL_PORT}
EQO_OPENBB_HOST_PORT=${RESEARCH_PORT}
EQO_PUBLIC_ORIGIN=${MAIN_ORIGIN}
NEXTAUTH_URL=${MAIN_ORIGIN}
EQO_RESEARCH_PUBLIC_ORIGIN=${RESEARCH_ORIGIN}
EQO_TERMINAL_PUBLIC_ORIGIN=${MAIN_ORIGIN}
E2E_LITE_IMAGE_TAG=${LITE_IMAGE}
NEXTAUTH_SECRET=${MAIN_NEXTAUTH_SECRET}
EQO_SESSION_TTL_SECONDS=900
EQO_OIDC_ISSUER=http://127.0.0.1:${MAIN_OIDC_PORT}
EQO_OIDC_CLIENT_ID=eqo-terminal-e2e
EQO_OIDC_CLIENT_SECRET=${MAIN_OIDC_SECRET}
EQO_GATEWAY_JWT_SECRET=${GATEWAY_JWT_SECRET}
EQO_RESEARCH_JWT_SECRET=${RESEARCH_JWT_SECRET}
EQO_RESEARCH_API_KEY=${RESEARCH_API_KEY}
EQO_OPENBB_NEXTAUTH_SECRET=${RESEARCH_NEXTAUTH_SECRET}
EQO_OPENBB_SESSION_TTL_SECONDS=900
EQO_OPENBB_OIDC_ISSUER=http://127.0.0.1:${RESEARCH_OIDC_PORT}
EQO_OPENBB_OIDC_CLIENT_ID=eqo-openbb-e2e
EQO_OPENBB_OIDC_CLIENT_SECRET=${RESEARCH_OIDC_SECRET}
OPENBB_ADMIN_EMAIL=${ADMIN_EMAIL}
OPENBB_ADMIN_PASSWORD=${ADMIN_PASSWORD}
E2E_MAIN_OIDC_HOST_PORT=${MAIN_OIDC_PORT}
E2E_MAIN_OIDC_PORT=${MAIN_OIDC_PORT}
E2E_OPENBB_OIDC_HOST_PORT=${RESEARCH_OIDC_PORT}
E2E_OPENBB_OIDC_PORT=${RESEARCH_OIDC_PORT}
E2E_ALPACA_HOST_PORT=${ALPACA_PORT}
E2E_CONTROL_TOKEN=${CONTROL_TOKEN}
E2E_MAIN_OIDC_CONTROL_TOKEN=${MAIN_OIDC_CONTROL_TOKEN}
E2E_RESEARCH_OIDC_CONTROL_TOKEN=${RESEARCH_OIDC_CONTROL_TOKEN}
E2E_MAIN_OIDC_CLIENT_SECRET=${MAIN_OIDC_SECRET}
E2E_RESEARCH_OIDC_CLIENT_SECRET=${RESEARCH_OIDC_SECRET}
E2E_OIDC_TOKEN_TTL_SECONDS=900
EOF
chmod 600 "${ENV_FILE}"

cat >"${ARTIFACT_DIR}/runtime-endpoints.json" <<EOF
{
  "compose_project": "${PROJECT_NAME}",
  "gateway_origin": "http://127.0.0.1:${GATEWAY_PORT}",
  "terminal_origin": "${MAIN_ORIGIN}",
  "research_origin": "${RESEARCH_ORIGIN}",
  "main_oidc_issuer": "http://127.0.0.1:${MAIN_OIDC_PORT}",
  "research_oidc_issuer": "http://127.0.0.1:${RESEARCH_OIDC_PORT}",
  "alpaca_fixture_origin": "${ALPACA_ORIGIN}",
  "alpaca_credentials": "test-only dummy values, Rust Gateway container only",
  "execution_mode": "disabled",
  "lite_image_tag": "${LITE_IMAGE}"
}
EOF

log_phase "Using unique Compose project ${PROJECT_NAME}; no host .env or real credentials are projected"
run_logged "Validate default Compose config without operator environment" "${ARTIFACT_DIR}/compose-default-config.log" \
  env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" DOCKER_CONFIG="${DOCKER_CONFIG_DIR}" \
    docker compose --env-file /dev/null config --quiet
run_logged "Validate default OpenBB profile config without operator environment" "${ARTIFACT_DIR}/compose-default-openbb-config.log" \
  env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" DOCKER_CONFIG="${DOCKER_CONFIG_DIR}" \
    docker compose --env-file /dev/null --profile openbb config --quiet
run_logged "Validate E2E overlay config" "${ARTIFACT_DIR}/compose-e2e-config.log" \
  compose_e2e --profile openbb config --quiet
run_logged "Run Docker archive verifier fault-injection tests" "${ARTIFACT_DIR}/openbb-archive-verifier-tests.log" \
  env -i PATH="${TASK_PATH}" python3 -B tests/test_openbb_docker_save_oci.py

if [[ "${OPENBB_E2E_SKIP_DEFAULT_PROFILE_SMOKE:-0}" == "1" ]]; then
  log_phase "Skip default profile rebuild/smoke for an explicitly requested diagnostic iteration; final acceptance must run without this flag"
else
  run_logged "Direct default-compose OpenBB profile build (includes compose.openbb.yaml)" \
    "${ARTIFACT_DIR}/compose-build.log" compose --profile openbb build --progress plain

  run_logged "Start and health-check the exact default Compose OpenBB profile command with generated disposable settings" \
    "${ARTIFACT_DIR}/compose-default-up.log" \
    compose --profile openbb up --detach --build --wait --wait-timeout 2700
  for service in eqoboard research terminal openbb-lite openbb-research-bff openbb-research-ingress; do
    assert_health "${service}"
  done
  compose down --volumes --remove-orphans
fi

run_logged "Start actual Rust Gateway, OpenTerminal, Node research, pinned native OpenBB Lite, BFF, controlled ingress, and loopback fixtures" \
  "${ARTIFACT_DIR}/compose-up.log" \
  compose_e2e --profile openbb up --detach --build --wait --wait-timeout 2700

for service in eqoboard research terminal openbb-lite openbb-research-bff openbb-research-ingress mock-openbb-alpaca mock-openbb-oidc-main mock-openbb-oidc-research; do
  assert_health "${service}"
done

log_phase "Probe all public origin boundaries and verify upstream-only internal services"
curl --fail --silent --show-error "http://127.0.0.1:${GATEWAY_PORT}/healthz" >/dev/null
curl --fail --silent --show-error "${MAIN_ORIGIN}/api/healthz" >/dev/null
curl --fail --silent --show-error "${RESEARCH_ORIGIN}/api/healthz" >/dev/null
curl --fail --silent --show-error "${RESEARCH_ORIGIN}/api/readyz" >/dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "${RESEARCH_ORIGIN}/api/research/auth-check")" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "${RESEARCH_ORIGIN}/api/openbb/widgets.json")" = 401
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "${RESEARCH_ORIGIN}/app/widgets")" = 302
compose exec -T openbb-lite curl --fail --silent --show-error http://127.0.0.1:3000/api/health >/dev/null
compose exec -T research node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

compose exec -T openbb-research-bff node -e '
  const forbidden=["EQO_GATEWAY_JWT_SECRET","EQO_RESEARCH_API_KEY","ALPACA_KEY","ALPACA_SECRET"];
  const present=forbidden.filter((key)=>Object.prototype.hasOwnProperty.call(process.env,key));
  const healthy=process.env.EQO_BFF_MODE==="research" && process.env.EQO_RESEARCH_JWT_SECRET && process.env.NEXTAUTH_SECRET && process.env.EQO_RESEARCH_JWT_SECRET!==process.env.NEXTAUTH_SECRET;
  if(present.length || !healthy){console.error(JSON.stringify({forbidden_names_present:present,research_bff_configured:Boolean(healthy)}));process.exit(1)}
  console.log(JSON.stringify({research_bff_mode:"research",forbidden_names_present:[],independent_secrets:true}));
' | tee -a "${RUN_LOG}"

compose exec -T openbb-lite python -c 'import os,sys; keys=("AI_COPILOT_ENABLED","MCP_DEFAULT_SERVER_ENABLED","DATA_ALLOW_HTML_JS_EXECUTION"); bad=[key for key in keys if os.environ.get(key)!="false"]; print("Lite safety flags: " + ("ok" if not bad else ",".join(bad))); sys.exit(bool(bad))' \
  | tee -a "${RUN_LOG}"

LITE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${LITE_IMAGE}")"
docker image inspect "${LITE_IMAGE}" >"${ARTIFACT_DIR}/openbb-lite-compose-image-inspect.json"
docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "${LITE_IMAGE}" >"${ARTIFACT_DIR}/openbb-lite-compose-image-repodigest.txt"
docker save "${LITE_IMAGE}" -o "${IMAGE_ARCHIVE}"
chmod 600 "${IMAGE_ARCHIVE}"
sha256sum "${IMAGE_ARCHIVE}" | tee "${ARTIFACT_DIR}/openbb-lite-compose-image.docker.tar.sha256"
python3 -B tools/openbb/verify_docker_save_oci.py \
  "${IMAGE_ARCHIVE}" "${LITE_IMAGE}" "${ARTIFACT_DIR}/openbb-lite-compose-image-inspect.json" \
  "${ARTIFACT_DIR}/openbb-lite-compose-archive-manifest.json"
printf '%s\n' "${LITE_IMAGE_ID}" >"${ARTIFACT_DIR}/openbb-lite-compose-image-id.txt"
chmod 600 "${ARTIFACT_DIR}/openbb-lite-compose-image-id.txt"
log_phase "Saved project-scoped Compose Lite image and Docker archive for rollback; Docker image id ${LITE_IMAGE_ID}"

if [[ -x "${ROOT_DIR}/apps/openterminal/node_modules/.bin/playwright" ]]; then
  log_phase "OpenTerminal workspace npm dependencies already installed"
else
  run_logged "Install locked OpenTerminal workspace dependencies" "${ARTIFACT_DIR}/npm-ci.log" \
    env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" npm --prefix apps/openterminal ci --no-audit --no-fund
fi

if ! find "${TASK_HOME}/.cache/ms-playwright" -maxdepth 1 -type d -name 'chromium-*' -print -quit 2>/dev/null | grep -q .; then
  run_logged "Install Playwright Chromium browser" "${ARTIFACT_DIR}/playwright-install.log" \
    env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" npm --prefix apps/openterminal exec -- playwright install chromium
fi

run_logged "Run real browser OIDC, native OpenBB email login, custom backend validation, 3 native widgets, provenance/feed/as-of, fail-closed pagination tests" \
  "${ARTIFACT_DIR}/playwright-openbb-native.log" \
  env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" \
    EQO_PUBLIC_ORIGIN="${MAIN_ORIGIN}" EQO_RESEARCH_PUBLIC_ORIGIN="${RESEARCH_ORIGIN}" \
    E2E_OPENBB_OIDC_ORIGIN="http://127.0.0.1:${RESEARCH_OIDC_PORT}" \
    E2E_MAIN_OIDC_ORIGIN="http://127.0.0.1:${MAIN_OIDC_PORT}" \
    E2E_ALPACA_ORIGIN="${ALPACA_ORIGIN}" E2E_CONTROL_TOKEN="${CONTROL_TOKEN}" \
    E2E_MAIN_OIDC_CONTROL_TOKEN="${MAIN_OIDC_CONTROL_TOKEN}" \
    E2E_RESEARCH_OIDC_CONTROL_TOKEN="${RESEARCH_OIDC_CONTROL_TOKEN}" \
    OPENBB_ADMIN_EMAIL="${ADMIN_EMAIL}" OPENBB_ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
    OPENBB_E2E_STORAGE_STATE="${STATE_FILE}" \
    OPENBB_MAIN_E2E_STORAGE_STATE="${MAIN_STATE_FILE}" \
    OPENBB_E2E_ARTIFACT_DIR="${ARTIFACT_DIR}" \
    OPENBB_E2E_JSON_REPORT="${PLAYWRIGHT_REPORT_FILE}" \
    npm --prefix apps/openterminal run test:e2e:openbb

log_phase "Stop only the actual Rust Gateway to prove the native widgets report the outage"
compose stop eqoboard
run_logged "Verify stored native workspace reports unavailable Rust Gateway" \
  "${ARTIFACT_DIR}/playwright-openbb-gateway-down.log" \
  env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" \
    EQO_PUBLIC_ORIGIN="${MAIN_ORIGIN}" EQO_RESEARCH_PUBLIC_ORIGIN="${RESEARCH_ORIGIN}" \
    OPENBB_E2E_ARTIFACT_DIR="${ARTIFACT_DIR}" OPENBB_E2E_STORAGE_STATE="${STATE_FILE}" \
    OPENBB_E2E_EXPECT_GATEWAY_OFFLINE=1 OPENBB_E2E_SCENARIO=gateway-offline \
    npm --prefix apps/openterminal run test:e2e:openbb:recovery

log_phase "Restart actual Rust Gateway and verify the previously loaded native widgets recover"
run_logged "Restart Rust Gateway" "${ARTIFACT_DIR}/compose-gateway-restart.log" \
  compose_e2e --profile openbb up --detach --no-deps --wait --wait-timeout 120 eqoboard
assert_health eqoboard
run_logged "Verify persisted native workspace and all three market APIs after Gateway restart" \
  "${ARTIFACT_DIR}/playwright-openbb-gateway-recovered.log" \
  env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" \
    EQO_PUBLIC_ORIGIN="${MAIN_ORIGIN}" EQO_RESEARCH_PUBLIC_ORIGIN="${RESEARCH_ORIGIN}" \
    OPENBB_E2E_ARTIFACT_DIR="${ARTIFACT_DIR}" OPENBB_E2E_STORAGE_STATE="${STATE_FILE}" \
    OPENBB_E2E_SCENARIO=gateway-restarted \
    npm --prefix apps/openterminal run test:e2e:openbb:recovery

log_phase "Stop only the three OpenBB profile services and prove core health and the signed-in native Terminal Workspace remain usable"
compose_e2e stop openbb-research-ingress openbb-lite openbb-research-bff
for service in eqoboard research terminal; do assert_health "${service}"; done
curl --fail --silent --show-error "http://127.0.0.1:${GATEWAY_PORT}/healthz" >/dev/null
curl --fail --silent --show-error "${MAIN_ORIGIN}/api/healthz" >/dev/null
run_logged "Verify signed-in OpenTerminal native workspace remains available while OpenBB is stopped" \
  "${ARTIFACT_DIR}/playwright-core-openbb-stopped.log" \
  env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" \
    EQO_PUBLIC_ORIGIN="${MAIN_ORIGIN}" EQO_RESEARCH_PUBLIC_ORIGIN="${RESEARCH_ORIGIN}" \
    OPENBB_MAIN_E2E_STORAGE_STATE="${MAIN_STATE_FILE}" \
    OPENBB_E2E_ARTIFACT_DIR="${ARTIFACT_DIR}" OPENBB_E2E_CORE_ONLY=1 \
    npm --prefix apps/openterminal run test:e2e:openbb
compose_e2e up --detach --no-build --wait --wait-timeout 120 \
  openbb-research-bff openbb-lite openbb-research-ingress

log_phase "Simulate a broken image upgrade, reject its failed healthcheck, then restore the saved exact image archive"
compose_e2e stop openbb-research-ingress openbb-lite
INGRESS_CONTAINER_ID="$(compose_e2e ps --all -q openbb-research-ingress)"
test -n "${INGRESS_CONTAINER_ID}"
BROKEN_UPGRADE_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${INGRESS_CONTAINER_ID}")"
docker image inspect "${BROKEN_UPGRADE_IMAGE_ID}" >/dev/null
ROLLBACK_TAG_MUTATED=1
docker image tag "${BROKEN_UPGRADE_IMAGE_ID}" "${LITE_IMAGE}"
compose_e2e --profile openbb up --detach --no-build --no-deps --force-recreate openbb-lite

broken_status=""
broken_health_wait_seconds="$(compose_e2e --profile openbb config --format json | node -e '
  let input="";
  process.stdin.on("data",(chunk)=>input+=chunk).on("end",()=>{
    try {
      const config=JSON.parse(input);
      const health=config.services?.["openbb-lite"]?.healthcheck;
      if(!health || !Number.isSafeInteger(health.retries) || health.retries < 1) throw new Error("OpenBB healthcheck is missing retries");
      const duration=(value)=>{
        if(typeof value!=="string" || value.length===0) throw new Error("OpenBB healthcheck duration is missing");
        const token=/([0-9]+)(ns|us|µs|ms|s|m|h)/gy;
        const scale={ns:1e-9,us:1e-6,"µs":1e-6,ms:1e-3,s:1,m:60,h:3600};
        let offset=0,total=0,match;
        while(offset<value.length){
          token.lastIndex=offset;
          match=token.exec(value);
          if(!match) throw new Error("unsupported OpenBB healthcheck duration");
          total+=Number(match[1])*scale[match[2]];
          offset=token.lastIndex;
        }
        return total;
      };
      const start=duration(health.start_period||"0s");
      const interval=duration(health.interval);
      const timeout=duration(health.timeout||"0s");
      const budget=Math.ceil(start+interval*health.retries+timeout+interval*3);
      if(!Number.isSafeInteger(budget) || budget<1 || budget>600) throw new Error("OpenBB healthcheck wait budget is outside its bounded range");
      process.stdout.write(String(budget));
    }catch(error){console.error(error.message);process.exitCode=1}
  });
')"
if [[ ! "${broken_health_wait_seconds}" =~ ^[0-9]+$ ]]; then
  printf 'Could not derive a bounded healthcheck wait from the OpenBB Compose profile\n' >&2
  exit 1
fi
log_phase "Waiting up to ${broken_health_wait_seconds}s, derived from the actual OpenBB Lite healthcheck settings, for the broken image to become unhealthy"
for _ in $(seq 1 $(((broken_health_wait_seconds + 1) / 2))); do
  broken_id="$(compose_e2e ps --all -q openbb-lite)"
  broken_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${broken_id}" 2>/dev/null || true)"
  [[ "${broken_status}" == unhealthy ]] && break
  sleep 2
done
test "${broken_status}" = unhealthy
printf '%s\n' "broken_upgrade_status=${broken_status}" | tee -a "${RUN_LOG}"
compose_e2e stop openbb-lite
compose_e2e rm --force openbb-lite
docker load -i "${IMAGE_ARCHIVE}" >"${ARTIFACT_DIR}/docker-load-rollback.log"
RESTORED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${LITE_IMAGE}")"
test "${RESTORED_IMAGE_ID}" = "${LITE_IMAGE_ID}"
ROLLBACK_TAG_MUTATED=0
printf '%s\n' "restored_image_id=${RESTORED_IMAGE_ID}" | tee -a "${RUN_LOG}"
printf '%s\n' "broken_upgrade_image_id=${BROKEN_UPGRADE_IMAGE_ID}" | tee -a "${RUN_LOG}"

compose_e2e --profile openbb up --detach --no-build --no-deps --wait --wait-timeout 120 \
  openbb-lite openbb-research-ingress
assert_health openbb-lite
assert_health openbb-research-bff
assert_health openbb-research-ingress
run_logged "Verify native widgets and unknown-source market rows after image rollback restore" \
  "${ARTIFACT_DIR}/playwright-openbb-rollback-restored.log" \
  env -i PATH="${TASK_PATH}" HOME="${TASK_HOME}" \
    EQO_PUBLIC_ORIGIN="${MAIN_ORIGIN}" EQO_RESEARCH_PUBLIC_ORIGIN="${RESEARCH_ORIGIN}" \
    OPENBB_E2E_ARTIFACT_DIR="${ARTIFACT_DIR}" OPENBB_E2E_STORAGE_STATE="${STATE_FILE}" \
    OPENBB_E2E_SCENARIO=rollback-restored \
    npm --prefix apps/openterminal run test:e2e:openbb:recovery

log_phase "E2E assertions completed; the EXIT trap will record PASS only after cleanup verification"
