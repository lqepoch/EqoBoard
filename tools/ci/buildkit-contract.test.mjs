import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coreWorkflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const optionalWorkflow = readFileSync(new URL("../../.github/workflows/openbb.yml", import.meta.url), "utf8");
const containerScript = readFileSync(new URL("../container-e2e.sh", import.meta.url), "utf8");
const openbbScript = readFileSync(new URL("../openbb-lite-e2e.sh", import.meta.url), "utf8");

function cacheScopes(workflow) {
  const from = [...workflow.matchAll(/cache-from:\s*type=gha,scope=([^,\s]+),version=2/g)].map((match) => match[1]);
  const to = [...workflow.matchAll(/cache-to:\s*type=gha,scope=([^,\s]+),mode=max,version=2,ignore-error=true/g)].map((match) => match[1]);
  return { from: [...new Set(from)].sort(), to: [...new Set(to)].sort() };
}

test("core and optional BuildKit caches use pinned actions and separate v2 scopes", () => {
  const shared = ["eqoboard-gateway", "openterminal-runtime", "openterminal-compose-e2e"];
  const optional = [...shared, "openbb-workspace-lite"];
  for (const workflow of [coreWorkflow, optionalWorkflow]) {
    assert.match(workflow, /docker\/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069/);
    assert.match(workflow, /docker\/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc/);
  }
  assert.deepEqual(cacheScopes(coreWorkflow), { from: [...shared].sort(), to: [...shared].sort() });
  assert.deepEqual(cacheScopes(optionalWorkflow), { from: [...optional].sort(), to: [...optional].sort() });
  assert.equal((coreWorkflow.match(/load:\s*true/g) ?? []).length, shared.length);
  assert.equal((optionalWorkflow.match(/load:\s*true/g) ?? []).length, optional.length);
  assert.doesNotMatch(coreWorkflow, /scope=openbb-workspace-lite|tools\/openbb-lite-e2e\.sh|tools\/openbb\/(?:fetch-upstream|source-sbom|patched-source-sbom|upstream-diff)\.sh/);
  assert.match(coreWorkflow, /bash tools\/container-e2e\.sh/);
  assert.match(optionalWorkflow, /bash tools\/openbb-lite-e2e\.sh/);
  assert.match(optionalWorkflow, /bash tools\/openbb\/fetch-upstream\.sh/);
  assert.match(optionalWorkflow, /bash tools\/openbb\/source-sbom\.sh/);
});

test("Compose E2E wrappers select the action-created Buildx builder without cache auth", () => {
  for (const script of [containerScript, openbbScript]) {
    assert.match(script, /BUILDX_BUILDER/);
    assert.match(script, /COMPOSE_BAKE/);
    assert.doesNotMatch(script, /ACTIONS_RUNTIME_TOKEN|ACTIONS_CACHE_URL|ACTIONS_RESULTS_URL/);
  }
  assert.match(coreWorkflow, /BUILDX_BUILDER:\s*\$\{\{\s*steps\.buildx\.outputs\.name\s*\}\}/);
  assert.match(coreWorkflow, /COMPOSE_BAKE:\s*["']?true/);
  assert.match(optionalWorkflow, /BUILDX_BUILDER:\s*\$\{\{\s*steps\.buildx\.outputs\.name\s*\}\}/);
  assert.match(optionalWorkflow, /COMPOSE_BAKE:\s*["']?true/);
  assert.match(optionalWorkflow, /name: OpenBB change routing/);
  assert.match(optionalWorkflow, /name: OpenBB source supply chain/);
  assert.match(optionalWorkflow, /name: OpenBB native runtime E2E/);
  assert.match(optionalWorkflow, /name: OpenBB optional validation gate/);
  assert.match(openbbScript, /trap cleanup EXIT/);
  assert.match(openbbScript, /trap 'exit 130' INT/);
  assert.match(openbbScript, /trap 'exit 143' TERM/);
});
