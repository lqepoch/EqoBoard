import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const containerScript = readFileSync(new URL("../container-e2e.sh", import.meta.url), "utf8");
const openbbScript = readFileSync(new URL("../openbb-lite-e2e.sh", import.meta.url), "utf8");

test("BuildKit cache actions use pinned Docker actions and isolated v2 scopes", () => {
  assert.match(workflow, /docker\/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069/);
  assert.match(workflow, /docker\/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc/);
  const fromScopes = [...workflow.matchAll(/cache-from:\s*type=gha,scope=([^,\s]+),version=2/g)].map((match) => match[1]);
  const toScopes = [...workflow.matchAll(/cache-to:\s*type=gha,scope=([^,\s]+),mode=max,version=2,ignore-error=true/g)].map((match) => match[1]);
  const expected = ["eqoboard-gateway", "openterminal-runtime", "openterminal-compose-e2e", "openbb-workspace-lite"];
  assert.deepEqual([...new Set(fromScopes)].sort(), [...expected].sort());
  assert.deepEqual([...new Set(toScopes)].sort(), [...expected].sort());
  assert.equal((workflow.match(/load:\s*true/g) ?? []).length, expected.length);
});

test("Compose E2E wrappers select the action-created Buildx builder without cache auth", () => {
  for (const script of [containerScript, openbbScript]) {
    assert.match(script, /BUILDX_BUILDER/);
    assert.match(script, /COMPOSE_BAKE/);
    assert.doesNotMatch(script, /ACTIONS_RUNTIME_TOKEN|ACTIONS_CACHE_URL|ACTIONS_RESULTS_URL/);
  }
  assert.match(workflow, /BUILDX_BUILDER:\s*\$\{\{\s*steps\.buildx\.outputs\.name\s*\}\}/);
  assert.match(workflow, /COMPOSE_BAKE:\s*["']?true/);
  const routeStep = workflow.match(/- name: Route native OpenBB Lite E2E for pull request paths([\s\S]*?)(?=\n      - |\n  [a-z_]+:)/)?.[1];
  assert.ok(routeStep, "route step must remain present");
  assert.doesNotMatch(routeStep, />>\s*\$GITHUB_OUTPUT/);
});
