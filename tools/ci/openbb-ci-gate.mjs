#!/usr/bin/env node

const LANE_RESULTS = new Set(["success", "skipped", "failure", "cancelled", "timed_out", "action_required", "neutral"]);

export function evaluateOpenbbGate({ routeResult, sourceSelected, sourceResult, runtimeSelected, runtimeResult }) {
  if (routeResult !== "success") return { pass: false, reason: "router-did-not-succeed" };
  if (!["true", "false"].includes(sourceSelected) || !["true", "false"].includes(runtimeSelected)) {
    return { pass: false, reason: "unknown-route-output" };
  }
  if (!LANE_RESULTS.has(sourceResult) || !LANE_RESULTS.has(runtimeResult)) {
    return { pass: false, reason: "unknown-lane-result" };
  }
  for (const [name, selected, result] of [
    ["source", sourceSelected, sourceResult],
    ["runtime", runtimeSelected, runtimeResult],
  ]) {
    if (selected === "true" && result !== "success") {
      return { pass: false, reason: `${name}-lane-${result}` };
    }
    if (selected === "false" && result !== "skipped") {
      return { pass: false, reason: `${name}-lane-unexpected-${result}` };
    }
  }
  return { pass: true, reason: "selected-lanes-succeeded-or-unrelated-skipped" };
}

function main() {
  const result = evaluateOpenbbGate({
    routeResult: process.env.ROUTE_RESULT ?? "",
    sourceSelected: process.env.SOURCE_SELECTED ?? "",
    sourceResult: process.env.SOURCE_RESULT ?? "",
    runtimeSelected: process.env.RUNTIME_SELECTED ?? "",
    runtimeResult: process.env.RUNTIME_RESULT ?? "",
  });
  process.stdout.write(`OpenBB optional validation gate: ${result.pass ? "PASS" : "FAIL"} (${result.reason})\n`);
  if (!result.pass) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("openbb-ci-gate.mjs")) main();
