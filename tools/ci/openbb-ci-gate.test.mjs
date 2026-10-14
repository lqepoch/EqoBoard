import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOpenbbGate } from "./openbb-ci-gate.mjs";

const skippedUnrelated = {
  routeResult: "success",
  sourceSelected: "false",
  sourceResult: "skipped",
  runtimeSelected: "false",
  runtimeResult: "skipped",
};

test("unrelated changes pass when both heavy lanes are explicitly skipped", () => {
  assert.deepEqual(evaluateOpenbbGate(skippedUnrelated), {
    pass: true,
    reason: "selected-lanes-succeeded-or-unrelated-skipped",
  });
});

test("selected source and runtime jobs may independently succeed", () => {
  assert.equal(evaluateOpenbbGate({
    routeResult: "success",
    sourceSelected: "true",
    sourceResult: "success",
    runtimeSelected: "false",
    runtimeResult: "skipped",
  }).pass, true);
  assert.equal(evaluateOpenbbGate({
    routeResult: "success",
    sourceSelected: "false",
    sourceResult: "skipped",
    runtimeSelected: "true",
    runtimeResult: "success",
  }).pass, true);
});

test("router failure, missing routing output, or unknown results fail closed", () => {
  for (const input of [
    { ...skippedUnrelated, routeResult: "failure" },
    { ...skippedUnrelated, sourceSelected: "" },
    { ...skippedUnrelated, runtimeResult: "unknown" },
  ]) assert.equal(evaluateOpenbbGate(input).pass, false);
});

test("a selected lane that fails, cancels, times out, or skips blocks the gate", () => {
  for (const result of ["failure", "cancelled", "timed_out", "skipped"]) {
    assert.equal(evaluateOpenbbGate({
      ...skippedUnrelated,
      runtimeSelected: "true",
      runtimeResult: result,
    }).pass, false, result);
  }
});

test("unselected lanes must remain skipped so an unexpected run cannot mask a routing bug", () => {
  assert.equal(evaluateOpenbbGate({
    ...skippedUnrelated,
    sourceResult: "success",
  }).pass, false);
});
