import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_HARNESS_ATTESTATION, PinePluginError, runIsolatedPineIndicator } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engineFile = (name) => join(here, "fixtures", "engines", `${name}.mjs`);
const pin = (name) => {
  const path = engineFile(name);
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
};
const sandbox = { attestation: DEV_HARNESS_ATTESTATION };
const script = '//@version=6\nindicator("SMA 2", overlay=true)\nplot(ta.sma(close, 2), "SMA")';
const bars = [
  { time: 1704067200, open: 100, high: 104, low: 98, close: 103, volume: 100 },
  { time: 1704153600, open: 103, high: 109, low: 102, close: 107, volume: 110 },
  { time: 1704240000, open: 107, high: 111, low: 106, close: 110, volume: 120 },
];
const evidence = { provider: "synthetic-fixture", symbol: "SPY", resolution: "1d", completeness: "unverified", feed: "synthetic" };
const request = () => ({ source: script, bars, evidence });

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof PinePluginError && error.code === code, `expected ${code}`);
}

test("refuses to start without an attested OS sandbox", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), engine: pin("sma-engine") }), "SANDBOX_NOT_ATTESTED");
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), engine: pin("sma-engine"), sandbox: { attestation: "trust-me" } }), "SANDBOX_NOT_ATTESTED");
});

test("fails closed without a pinned engine or with a relative engine path", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox }), "ENGINE_UNAVAILABLE");
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: { path: "engine.mjs", sha256: "0".repeat(64) } }), "ENGINE_UNAVAILABLE");
});

test("refuses an engine whose bytes do not match the pinned digest", async () => {
  const engine = { path: engineFile("sma-engine"), sha256: "f".repeat(64) };
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine }), "ENGINE_DIGEST_MISMATCH");
});

test("rejects a malformed tenant identifier and an oversized request before spawning", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "../etc", request: request(), sandbox, engine: pin("sma-engine") }), "INVALID_TENANT");
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("sma-engine"), limits: { requestBytes: 10 } }), "INVALID_REQUEST");
});

test("runs a pinned fixture engine end to end and returns validated plots", async () => {
  const result = await runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("sma-engine") });
  assert.equal(result.engine, "fixture-sma-2");
  assert.equal(result.executionMode, "historical-read-only");
  assert.deepEqual(result.orderIntents, []);
  const sma = result.plots.find((plot) => plot.title === "SMA");
  assert.deepEqual(sma.points.map((point) => point.value), [105, 108.5]);
});

test("the worker environment carries no service keys", async () => {
  process.env.ALPACA_SECRET = "test-only-secret";
  try {
    const result = await runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("env-engine") });
    const visible = result.plots[0].title.split(",");
    // macOS may add its own Core Foundation variable at process start; nothing else from the parent is allowed.
    const allowed = new Set(["LANG", "NODE_ENV", "PATH", "__CF_USER_TEXT_ENCODING"]);
    assert.ok(visible.every((key) => allowed.has(key)), `unexpected worker environment: ${visible.join(",")}`);
    assert.equal(visible.includes("ALPACA_SECRET"), false);
  } finally {
    delete process.env.ALPACA_SECRET;
  }
});

test("a non-terminating engine is killed at its time limit and its process is gone afterwards", async () => {
  const error = await runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("spin-engine"), limits: { timeoutMs: 1_500 } })
    .then(() => null, (caught) => caught);
  assert.ok(error instanceof PinePluginError);
  assert.equal(error.code, "TIMEOUT");
  const pid = error.details.pid;
  assert.throws(() => process.kill(pid, 0), (caught) => caught.code === "ESRCH", "worker process must be reaped");
});

test("an engine that exhausts its heap crashes without a result", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("oom-engine") }), "WORKER_CRASHED");
});

test("output beyond the response limit kills the worker", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("noisy-engine"), limits: { responseBytes: 65_536 } }), "OUTPUT_LIMIT");
});

test("child process creation is denied by the permission model", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("spawn-engine") }), "ENGINE_FAILURE");
});

test("writes outside the worker are denied by the permission model", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("write-engine") }), "ENGINE_FAILURE");
  const escaped = join(process.env.HOME ?? "/", "pine-worker-escape.txt");
  assert.equal(existsSync(escaped), false);
});

test("unbounded recursion surfaces as a generic engine failure", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("deep-engine") }), "ENGINE_FAILURE");
});

test("an engine without an identifier is refused by the runtime", async () => {
  await expectCode(runIsolatedPineIndicator({ tenantId: "t1", request: request(), sandbox, engine: pin("badid-engine") }), "ENGINE_UNAVAILABLE");
});

test("a tenant cannot exceed its concurrent worker quota", async () => {
  const slow = { engine: pin("spin-engine"), limits: { timeoutMs: 1_500 } };
  const first = runIsolatedPineIndicator({ tenantId: "quota-t", request: request(), sandbox, ...slow });
  const second = runIsolatedPineIndicator({ tenantId: "quota-t", request: request(), sandbox, ...slow });
  await expectCode(runIsolatedPineIndicator({ tenantId: "quota-t", request: request(), sandbox, ...slow }), "QUOTA_EXCEEDED");
  const outcomes = await Promise.allSettled([first, second]);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason.code === "TIMEOUT"));
  // Quota is released after the runs finish.
  await expectCode(runIsolatedPineIndicator({ tenantId: "quota-t", request: request(), sandbox, engine: pin("badid-engine") }), "ENGINE_UNAVAILABLE");
});
