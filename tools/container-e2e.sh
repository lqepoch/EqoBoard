#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="eqoboard-container-e2e-$$"
gateway_host_port=$((38000 + $$ % 500))
terminal_host_port=$((39000 + $$ % 500))
oidc_host_port=14310
mock_gateway_host_port=14311
mock_research_host_port=14312
e2e_env_file="$(mktemp)"
gateway_ready_file="$(mktemp)"
terminal_ready_file="$(mktemp)"
compose_args=(--project-name "$project" --env-file "$e2e_env_file" -f "$repo_root/compose.yaml")

# This run must remain offline and must never inherit an operator's market key.
dc() {
  env \
    -u ALPACA_KEY -u ALPACA_SECRET \
    -u EQO_GATEWAY_JWT_SECRET -u EQO_RESEARCH_JWT_SECRET \
    -u EQO_GATEWAY_HOST_PORT -u EQO_TERMINAL_HOST_PORT \
    -u EQO_RESEARCH_API_KEY -u EQO_OIDC_CLIENT_SECRET -u NEXTAUTH_SECRET \
    -u EQO_PUBLIC_ORIGIN -u NEXTAUTH_URL -u EQO_SESSION_TTL_SECONDS \
    -u EQO_OIDC_ISSUER -u EQO_OIDC_CLIENT_ID \
    -u E2E_OIDC_HOST_PORT -u E2E_GATEWAY_HOST_PORT -u E2E_RESEARCH_HOST_PORT \
    -u E2E_OIDC_PORT -u E2E_GATEWAY_PORT -u E2E_RESEARCH_PORT -u E2E_SESSION_TTL_SECONDS \
    -u E2E_MDP_PORT -u EQO_MDP_URL -u MDP_TERMINAL_JWT_SECRET \
    -u E2E_QUANT_PORT -u EQO_QUANT_RESEARCH_URL -u QUANT_TERMINAL_JWT_SECRET -u QUANT_RESEARCH_JWT_SECRET \
    -u E2E_ENGINE_PORT -u EQO_ENGINE_URL -u ENGINE_TERMINAL_JWT_SECRET -u ENGINE_RESEARCH_JWT_SECRET \
    -u E2E_WEB_ORIGIN -u E2E_OIDC_ORIGIN \
    docker compose "${compose_args[@]}" "$@"
}

# Host-side Playwright and mock processes get only this explicit runtime
# allowlist. Never let a developer shell's broker/OIDC/service credentials flow
# into test runners or the local mock webServer child processes.
run_host_e2e() {
  env -i \
    PATH="$PATH" \
    HOME="${HOME:-/tmp}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-C.UTF-8}" \
    LC_ALL="${LC_ALL:-C.UTF-8}" \
    TZ="${TZ:-UTC}" \
    CI="${CI:-}" \
    npm_config_userconfig=/dev/null \
    "$@"
}

run_development_smoke() {
  # Docker Compose teardown changes the host network while Chromium may keep
  # Next's HMR websocket open. Run the development-only smoke before any
  # Compose lifecycle operations so the network remains stable for the test.
  printf '%s\n' 'Running development-only preview-race and typed UNKNOWN browser checks before Docker Compose starts.'
  local dev_ports_output
  dev_ports_output="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" node -e '
    const net = require("node:net");
    const servers = Array.from({ length: 4 }, () => net.createServer());
    Promise.all(servers.map((server) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }))).then(async () => {
      for (const server of servers) console.log(server.address().port);
      await Promise.all(servers.map((server) => new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      )));
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  ')"
  local -a dev_ports
  mapfile -t dev_ports <<< "$dev_ports_output"
  test "${#dev_ports[@]}" -eq 4
  local dev_web_port=${dev_ports[0]}
  local dev_oidc_port=${dev_ports[1]}
  local dev_gateway_port=${dev_ports[2]}
  local dev_research_port=${dev_ports[3]}
  (
    cd "$repo_root/apps/openterminal"
    run_host_e2e \
      "E2E_WEB_PORT=$dev_web_port" \
      "E2E_OIDC_PORT=$dev_oidc_port" \
      "E2E_GATEWAY_PORT=$dev_gateway_port" \
      "E2E_RESEARCH_PORT=$dev_research_port" \
      "E2E_WEB_ORIGIN=http://127.0.0.1:$dev_web_port" \
      "E2E_OIDC_ORIGIN=http://127.0.0.1:$dev_oidc_port" \
      E2E_SESSION_TTL_SECONDS=120 \
      npm run test:e2e --workspace web -- --grep 'late preview|typed UNKNOWN|preview expiry'
  )
}

cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    dc logs --no-color || true
  fi
  dc down --volumes --remove-orphans --timeout 5 || true
  rm -f "$e2e_env_file" "$gateway_ready_file" "$terminal_ready_file"
  exit "$result"
}
trap cleanup EXIT

cat > "$e2e_env_file" <<'EOF'
# Offline-only fixture credentials: identity configuration, never market keys.
EQO_GATEWAY_JWT_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
EQO_RESEARCH_JWT_SECRET=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr
EQO_RESEARCH_API_KEY=research-service-test-key-that-is-at-least-32-bytes
EOF
cat >> "$e2e_env_file" <<EOF
EQO_GATEWAY_HOST_PORT=$gateway_host_port
EQO_TERMINAL_HOST_PORT=$terminal_host_port
E2E_OIDC_HOST_PORT=$oidc_host_port
E2E_GATEWAY_HOST_PORT=$mock_gateway_host_port
E2E_RESEARCH_HOST_PORT=$mock_research_host_port
E2E_OIDC_PORT=$oidc_host_port
E2E_GATEWAY_PORT=$mock_gateway_host_port
E2E_RESEARCH_PORT=$mock_research_host_port
E2E_MDP_PORT=14313
E2E_QUANT_PORT=14314
E2E_ENGINE_PORT=14315
E2E_SESSION_TTL_SECONDS=${E2E_SESSION_TTL_SECONDS:-30}
EQO_PUBLIC_ORIGIN=http://127.0.0.1:$terminal_host_port
NEXTAUTH_URL=http://127.0.0.1:$terminal_host_port
EOF

run_development_smoke

if [[ ${E2E_ONLY:-0} != 1 ]]; then
printf '%s\n' 'Checking and building production Compose services.'
dc config --quiet
env -u ALPACA_KEY -u ALPACA_SECRET -u EQO_GATEWAY_JWT_SECRET -u EQO_RESEARCH_JWT_SECRET \
  -u EQO_RESEARCH_API_KEY -u EQO_OIDC_CLIENT_SECRET -u NEXTAUTH_SECRET \
  docker compose --project-name "$project" --env-file "$e2e_env_file" \
    -f "$repo_root/compose.yaml" -f "$repo_root/compose.offline.yaml" config --quiet
dc build --progress plain
gateway_image="${project}-eqoboard:latest"
set +e
missing_key_output="$(docker run --rm --network none -e EQO_BIND=0.0.0.0:8080 "$gateway_image" 2>&1)"
missing_key_status=$?
set -e
test "$missing_key_status" -ne 0
printf '%s\n' "$missing_key_output" | grep -F 'non-loopback bind requires verifiable gateway and research JWT keys' >/dev/null
printf '%s\n' 'Negative startup check: non-loopback Gateway rejects absent identity keys.'
dc up --detach --wait --wait-timeout 240

gateway_id="$(dc ps --quiet eqoboard)"
terminal_id="$(dc ps --quiet terminal)"
research_id="$(dc ps --quiet research)"
test -n "$gateway_id" && test -n "$terminal_id" && test -n "$research_id"

printf '%s\n' 'Recording actual production command and image identities.'
for container_id in "$gateway_id" "$terminal_id" "$research_id"; do
  docker inspect --format '{{.Name}} image={{.Config.Image}} image_id={{.Image}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}} path={{.Path}} args={{json .Args}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} host_ports={{json .HostConfig.PortBindings}} runtime_ports={{json .NetworkSettings.Ports}}' "$container_id"
done
terminal_image_id="$(docker inspect --format '{{.Image}}' "$terminal_id")"
research_image_id="$(docker inspect --format '{{.Image}}' "$research_id")"
test "$terminal_image_id" = "$research_image_id"

printf '%s\n' 'Checking production liveness and fail-closed readiness without OIDC or data credentials.'
curl --fail --silent --show-error "http://127.0.0.1:$gateway_host_port/healthz"
curl --fail --silent --show-error "http://127.0.0.1:$terminal_host_port/api/healthz"
gateway_ready_status="$(curl --silent --output "$gateway_ready_file" --write-out '%{http_code}' "http://127.0.0.1:$gateway_host_port/readyz")"
terminal_ready_status="$(curl --silent --output "$terminal_ready_file" --write-out '%{http_code}' "http://127.0.0.1:$terminal_host_port/api/readyz")"
test "$gateway_ready_status" = 200
test "$terminal_ready_status" = 503
cat "$gateway_ready_file" "$terminal_ready_file"
curl --fail --silent --show-error "http://127.0.0.1:$terminal_host_port/" | grep -F 'Sign-in is not configured' >/dev/null
dc exec --no-TTY research node -e "fetch('http://127.0.0.1:4000/healthz').then(async r=>{console.log('research healthz',r.status,await r.text());if(!r.ok)process.exit(1)})"
dc exec --no-TTY research node -e "fetch('http://127.0.0.1:4000/readyz').then(async r=>{console.log('research readyz',r.status,await r.text());if(!r.ok)process.exit(1)})"
node -e 'fetch(process.argv[1]).then(response=>response.json()).then(value=>{if(value.identity_validation_configured!==true||value.market_data_ready!==false||value.execution_enabled!==false)process.exit(1);console.log("identity_validation_configured="+value.identity_validation_configured+" market_data_ready="+value.market_data_ready+" execution_enabled="+value.execution_enabled+" data_status="+value.market_data_status)})' "http://127.0.0.1:$gateway_host_port/readyz"

printf '%s\n' 'Checking runtime user, readonly root filesystems, and writable named volumes.'
docker inspect --format 'gateway_user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}}' "$gateway_id" | grep -F 'gateway_user=eqo readonly=true' >/dev/null
docker inspect --format 'terminal_user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}}' "$terminal_id" | grep -F 'terminal_user=node readonly=true' >/dev/null
docker inspect --format 'research_user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}}' "$research_id" | grep -F 'research_user=node readonly=true' >/dev/null
dc exec --no-TTY terminal node -e "const fs=require('node:fs');try{fs.writeFileSync('/srv/web/.compose-readonly-probe','x');process.exit(1)}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}fs.writeFileSync('/srv/web/.next/cache/.compose-volume-probe','ok');fs.unlinkSync('/srv/web/.next/cache/.compose-volume-probe');console.log('terminal readonly path rejected; cache volume writable')"
dc exec --no-TTY research node -e "const fs=require('node:fs');try{fs.writeFileSync('/srv/server/.compose-readonly-probe','x');process.exit(1)}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}fs.writeFileSync('/var/lib/openterminal/.compose-volume-probe','ok');fs.unlinkSync('/var/lib/openterminal/.compose-volume-probe');console.log('research readonly path rejected; data volume writable')"
dc exec --no-TTY eqoboard /bin/sh -c 'test "$(id -u)" = 10001 && : > /var/lib/eqoboard/.compose-volume-probe && rm /var/lib/eqoboard/.compose-volume-probe && echo "gateway readonly root; audit volume writable as uid $(id -u)"'

printf '%s\n' 'Restarting all production services and rebuilding the Next cache volume.'
dc restart eqoboard terminal research
dc up --detach --wait --wait-timeout 90
dc stop terminal
dc rm --force terminal
docker volume rm "${project}_openterminal-next-cache"
dc up --detach --wait --wait-timeout 120 terminal
dc exec --no-TTY terminal node -e "const fs=require('node:fs');fs.writeFileSync('/srv/web/.next/cache/.compose-recreated-volume','ok');fs.unlinkSync('/srv/web/.next/cache/.compose-recreated-volume');console.log('recreated Next cache volume writable')"
dc down --volumes --remove-orphans --timeout 5
fi

compose_args=(--project-name "$project" --env-file "$e2e_env_file" -f "$repo_root/compose.yaml" -f "$repo_root/compose.e2e.yaml")
printf '%s\n' 'Starting isolated Compose E2E services with only test credentials and offline mocks.'
dc config --quiet
dc build --progress plain
dc up --detach --wait --wait-timeout 180
curl --fail --silent --show-error "http://127.0.0.1:$gateway_host_port/healthz"
curl --fail --silent --show-error "http://127.0.0.1:$gateway_host_port/readyz"
node -e 'fetch(process.argv[1]).then(response=>response.json()).then(value=>{if(value.market_data_ready!==false||value.execution_enabled!==false)process.exit(1);console.log("market_data_ready="+value.market_data_ready+" execution_enabled="+value.execution_enabled+" data_status="+value.market_data_status)})' "http://127.0.0.1:$gateway_host_port/readyz"
curl --fail --silent --show-error "http://127.0.0.1:$terminal_host_port/api/healthz"
curl --fail --silent --show-error "http://127.0.0.1:$terminal_host_port/api/readyz"
dc exec --no-TTY research node -e "fetch('http://127.0.0.1:4000/readyz').then(async r=>{console.log('research readyz',r.status,await r.text());if(!r.ok)process.exit(1)})"

printf '%s\n' 'Running real browser tests against the production Next container and offline OIDC/Gateway/research mocks.'
cd "$repo_root/apps/openterminal"
playwright_args=(--config playwright.compose.config.ts)
if [[ -n ${E2E_GREP:-} ]]; then playwright_args+=(--grep "$E2E_GREP"); fi
run_host_e2e \
  "E2E_WEB_ORIGIN=http://127.0.0.1:$terminal_host_port" \
  "E2E_OIDC_ORIGIN=http://127.0.0.1:$oidc_host_port" \
  E2E_PRODUCTION=1 \
  npm run test:e2e -w web -- "${playwright_args[@]}"
