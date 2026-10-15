#!/usr/bin/env bash
set -Eeuo pipefail

# Run browser tests against the production images and isolated offline fixtures.
# This is an Actions-only entry point; local builds are not deployment evidence.
if [[ ${GITHUB_ACTIONS:-} != true ]]; then
  printf '%s\n' 'native web Compose E2E must run in GitHub Actions.' >&2
  exit 2
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${NATIVE_CANDIDATE_SHA:?NATIVE_CANDIDATE_SHA must identify the checked-out candidate commit}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${NATIVE_WEB_IMAGE:?NATIVE_WEB_IMAGE must name the already-built production image}"
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

compose_file="$repo_root/compose.native.yaml"
e2e_overlay="$repo_root/compose.native.e2e.yaml"
app_dir="$repo_root/apps/eqoboard-web"
native_web_host_port="${NATIVE_WEB_HOST_PORT:-3440}"
web_service="native-web"
web_port=3000
research_service="native-research"
research_port=3000
research_host_port=3441
gateway_service="native-mock-gateway"
gateway_port=4451
mdp_service="market-data-platform"
mdp_port=4452
oidc_service="native-mock-oidc"
oidc_port=4450
compose_project="native-web-e2e-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}"
e2e_home="$RUNNER_TEMP/native-web-e2e-home"

if [[ ! -f "$compose_file" ]]; then
  printf 'Native Compose file is missing: %s\n' "$compose_file" >&2
  exit 2
fi
if [[ ! -f "$e2e_overlay" ]]; then
  printf 'Native E2E Compose overlay is missing: %s\n' "$e2e_overlay" >&2
  exit 2
fi
if [[ ! "$native_web_host_port" =~ ^[0-9]{1,5}$ ]] || (( 10#$native_web_host_port < 1 || 10#$native_web_host_port > 65535 )); then
  printf 'NATIVE_WEB_HOST_PORT must be a TCP port; got: %s\n' "$native_web_host_port" >&2
  exit 2
fi
if [[ ! -f "$app_dir/package.json" ]]; then
  printf 'Native app package is missing: %s\n' "$app_dir/package.json" >&2
  exit 2
fi
if [[ ! -x "$app_dir/node_modules/.bin/playwright" ]]; then
  printf '%s\n' 'Install the native app lockfile before invoking this helper.' >&2
  exit 2
fi

mkdir -p "$e2e_home"

# Compose receives an explicit allowlist. Runner secrets, broker credentials,
# and operator .env values must never flow into the mock-only fixture.
dc() {
  env -i \
    PATH="$PATH" \
    HOME="$e2e_home" \
    TMPDIR="$RUNNER_TEMP" \
    LANG="${LANG:-C.UTF-8}" \
    LC_ALL="${LC_ALL:-C.UTF-8}" \
    TZ=UTC \
    CI=true \
    DOCKER_HOST=unix:///var/run/docker.sock \
    COMPOSE_PROJECT_NAME="$compose_project" \
    NATIVE_WEB_IMAGE="$NATIVE_WEB_IMAGE" \
    NATIVE_WEB_HOST_PORT="$native_web_host_port" \
    docker compose --project-name "$compose_project" --env-file /dev/null --profile native -f "$compose_file" -f "$e2e_overlay" "$@"
}

cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    printf '%s\n' 'Native Compose fixture status at failure:' >&2
    dc ps --all >&2 || true
  fi
  dc down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  rm -rf "$e2e_home"
  exit "$result"
}
trap cleanup EXIT

expected_web_origin="http://127.0.0.1:$native_web_host_port"
expected_research_origin="http://localhost:$research_host_port"
expected_oidc_origins="$expected_web_origin,$expected_research_origin"
dc config --format json | python3 -c '
import json
import sys

config = json.load(sys.stdin)
expected_web, expected_research, expected_oidc = sys.argv[1:4]
services = config.get("services", {})

def validate_app_container_sandbox(service_name):
    service = services.get(service_name, {})
    if not isinstance(service, dict):
        raise SystemExit(f"{service_name} Compose service must be an object")

    mounts = service.get("tmpfs")
    if not isinstance(mounts, list) or len(mounts) != 1 or not isinstance(mounts[0], str):
        raise SystemExit(f"{service_name} must have exactly one /tmp tmpfs mount")
    target, separator, raw_options = mounts[0].partition(":")
    required_options = {"rw", "noexec", "nosuid", "size=64m"}
    options = raw_options.split(",") if separator else []
    if (
        target != "/tmp"
        or len(options) != len(required_options)
        or set(options) != required_options
    ):
        raise SystemExit(f"{service_name} /tmp tmpfs must use rw,noexec,nosuid,size=64m")

    if service.get("read_only") is not True:
        raise SystemExit(f"{service_name} must use a read-only root filesystem")
    if "ALL" not in service.get("cap_drop", []):
        raise SystemExit(f"{service_name} must drop all Linux capabilities")
    if "no-new-privileges:true" not in service.get("security_opt", []):
        raise SystemExit(f"{service_name} must enable no-new-privileges")


for app_service_name in ("native-web", "native-research"):
    validate_app_container_sandbox(app_service_name)

def environment(service_name):
    value = services.get(service_name, {}).get("environment", {})
    if isinstance(value, list):
        return dict(item.split("=", 1) for item in value if "=" in item)
    return value if isinstance(value, dict) else {}

terminal = environment("native-web")
research = environment("native-research")
oidc = environment("native-mock-oidc")
for name in ("NEXTAUTH_URL", "EQO_PUBLIC_ORIGIN"):
    if terminal.get(name) != expected_web:
        raise SystemExit(f"native-web {name} must match its loopback origin")
for name in ("NEXTAUTH_URL", "EQO_PUBLIC_ORIGIN"):
    if research.get(name) != expected_research:
        raise SystemExit(f"native-research {name} must match its separate localhost origin")
if oidc.get("EQO_PUBLIC_ORIGINS") != expected_oidc:
    raise SystemExit("mock OIDC callback allowlist must contain exactly the terminal and research origins")
if not services.get("native-web", {}).get("image") or services.get("native-web", {}).get("image") != services.get("native-research", {}).get("image"):
    raise SystemExit("native-web and native-research must use the same production image")
if not terminal.get("NEXTAUTH_SECRET") or not research.get("NEXTAUTH_SECRET") or terminal["NEXTAUTH_SECRET"] == research["NEXTAUTH_SECRET"]:
    raise SystemExit("terminal and research NextAuth secrets must be separate server-only values")
terminal_gateway_secret = terminal.get("EQO_GATEWAY_JWT_SECRET")
if not terminal_gateway_secret:
    raise SystemExit("native-web must receive its terminal Gateway signer")
if terminal_gateway_secret in {terminal.get("NEXTAUTH_SECRET"), research.get("NEXTAUTH_SECRET")}:
    raise SystemExit("terminal Gateway signer must be distinct from both app session secrets")
gateway = environment("native-mock-gateway")
if not gateway:
    raise SystemExit("native-mock-gateway service is required")
if gateway.get("EQO_GATEWAY_JWT_SECRET") != terminal_gateway_secret:
    raise SystemExit("Gateway fixture must verify the terminal Gateway signer")
if gateway.get("EQO_RESEARCH_JWT_SECRET"):
    raise SystemExit("Gateway fixture must not receive a Research Gateway signer")

research_forbidden_secrets = (
    "EQO_RUST_URL",
    "EQO_GATEWAY_JWT_SECRET",
    "EQO_RESEARCH_JWT_SECRET",
    "MDP_TERMINAL_JWT_SECRET",
    "QUANT_TERMINAL_JWT_SECRET",
    "ENGINE_TERMINAL_JWT_SECRET",
    "ENGINE_RESEARCH_JWT_SECRET",
    "QUANT_RESEARCH_JWT_SECRET",
    "EQO_ENGINE_URL",
    "EQO_QUANT_RESEARCH_URL",
    "EQO_RESEARCH_API_KEY",
    "EQO_ACCESS_TOKEN",
    "ALPACA_KEY",
    "ALPACA_SECRET",
    "EQO_ADAPTER_ALPACA_TOKEN",
    "EQO_ADAPTER_IBKR_TOKEN",
    "EQO_ADAPTER_SCHWAB_TOKEN",
    "ANTHROPIC_API_KEY",
)
for name in research_forbidden_secrets:
    if research.get(name):
        raise SystemExit(f"native-research must not receive {name}")

if not research.get("MDP_RESEARCH_JWT_SECRET"):
    raise SystemExit("native-research must receive its isolated MDP delegation secret")
if research.get("EQO_MDP_URL") != "http://market-data-platform:4452":
    raise SystemExit("native-research must target the isolated market-data-platform fixture")
mdp = environment("market-data-platform")
if not mdp.get("MDP_RESEARCH_JWT_SECRET") or mdp["MDP_RESEARCH_JWT_SECRET"] != research["MDP_RESEARCH_JWT_SECRET"]:
    raise SystemExit("research app and MDP fixture must share only the MDP delegation secret")
if mdp["MDP_RESEARCH_JWT_SECRET"] in {
    terminal.get("NEXTAUTH_SECRET"),
    research.get("NEXTAUTH_SECRET"),
    terminal_gateway_secret,
}:
    raise SystemExit("MDP delegation secret must differ from both sessions and terminal Gateway signer")
' "$expected_web_origin" "$expected_research_origin" "$expected_oidc_origins"
dc up --detach --wait --wait-timeout 180

published="$(dc port "$web_service" "$web_port")"
if [[ "$published" != "127.0.0.1:$native_web_host_port" ]]; then
  printf 'Native web must publish at %s; Compose reported: %s\n' "$expected_web_origin" "$published" >&2
  exit 1
fi
web_origin="http://$published"

research_binding="$(dc port "$research_service" "$research_port")"
if [[ "$research_binding" != "127.0.0.1:$research_host_port" ]]; then
  printf 'Native research must publish at %s; Compose reported: %s\n' "$expected_research_origin" "$research_binding" >&2
  exit 1
fi
research_origin="$expected_research_origin"

oidc_binding="$(dc port "$oidc_service" "$oidc_port")"
if [[ "$oidc_binding" != "127.0.0.1:$oidc_port" ]]; then
  printf 'Mock OIDC must bind to 127.0.0.1:%s for the Chromium issuer alias; got: %s\n' "$oidc_port" "$oidc_binding" >&2
  exit 1
fi

loopback_control_origin() {
  local service="$1"
  local port="$2"
  local label="$3"
  local binding
  local host_port
  binding="$(dc port "$service" "$port")"
  if [[ "$binding" != 127.0.0.1:* && "$binding" != localhost:* && "$binding" != '[::1]:'* ]]; then
    printf '%s fixture control API must publish only on loopback; got: %s\n' "$label" "$binding" >&2
    return 1
  fi
  host_port="${binding##*:}"
  if [[ ! "$host_port" =~ ^[0-9]+$ ]]; then
    printf 'Compose returned an invalid %s fixture port: %s\n' "$label" "$binding" >&2
    return 1
  fi
  local origin="http://127.0.0.1:$host_port"
  curl --noproxy '*' --connect-timeout 3 --max-time 10 --fail --silent --show-error "$origin/healthz" >/dev/null
  printf '%s' "$origin"
}

fixture_control_origin="$(loopback_control_origin "$gateway_service" "$gateway_port" 'Gateway')"
mdp_fixture_control_origin="$(loopback_control_origin "$mdp_service" "$mdp_port" 'MDP')"
curl --noproxy '*' --connect-timeout 3 --max-time 10 --fail --silent --show-error "http://127.0.0.1:$oidc_port/healthz" >/dev/null

# Compose health checks establish service readiness. Probe both production image
# origins because browser tests exercise host-only cookie separation.
wait_http_ready() {
  local origin="$1"
  local label="$2"
  local ready=0
  for _ in {1..30}; do
    if curl --noproxy '*' --connect-timeout 3 --max-time 10 --fail --silent --show-error --output /dev/null "$origin/"; then
      ready=1
      break
    fi
    sleep 2
  done
  if (( ready != 1 )); then
    printf '%s did not serve HTTP at %s within 60 seconds.\n' "$label" "$origin" >&2
    return 1
  fi
}
wait_http_ready "$web_origin" 'Native web'
wait_http_ready "$research_origin" 'Native research'

cd "$app_dir"
env -i \
  PATH="$PATH" \
  HOME="$e2e_home" \
  TMPDIR="$RUNNER_TEMP" \
  LANG="${LANG:-C.UTF-8}" \
  LC_ALL="${LC_ALL:-C.UTF-8}" \
  TZ=UTC \
  CI=true \
  npm_config_userconfig=/dev/null \
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$RUNNER_TEMP/ms-playwright}" \
  E2E_WEB_ORIGIN="$web_origin" \
  E2E_RESEARCH_WEB_ORIGIN="$research_origin" \
  E2E_FIXTURE_CONTROL_ORIGIN="$fixture_control_origin" \
  E2E_MDP_FIXTURE_CONTROL_ORIGIN="$mdp_fixture_control_origin" \
  E2E_CANDIDATE_SHA="$NATIVE_CANDIDATE_SHA" \
  npm run test:e2e
