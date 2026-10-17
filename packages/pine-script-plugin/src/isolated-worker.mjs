import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PinePluginError } from "./contract.mjs";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CHILD_ENTRY = join(PACKAGE_DIR, "src", "worker-child.mjs");
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Node's permission model denies filesystem access and process creation in the worker, but it does not
 * restrict the network. Only a harness that has been attested to run under an OS sandbox with no egress
 * may pass this value. The development value below exists for local tests and must never reach production.
 */
export const DEV_HARNESS_ATTESTATION = "dev-harness-no-os-sandbox";

export const WORKER_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  heapMb: 96,
  requestBytes: 1_048_576,
  responseBytes: 4_194_304,
  maxConcurrentPerTenant: 2,
  killGraceMs: 2_000,
});

// Child environment is rebuilt from nothing: no service keys, broker credentials or proxy settings reach it.
const CHILD_ENV = Object.freeze({ PATH: "", NODE_ENV: "production", LANG: "C.UTF-8" });
const active = new Map();

function fail(code, message, details) {
  const error = new PinePluginError(code, message);
  if (details) error.details = Object.freeze({ ...details });
  throw error;
}

/**
 * Runs one read-only indicator in a separate, permission-restricted process. The request is a validated
 * source + bars + evidence object; the engine is an explicitly configured module pinned by SHA-256.
 * Fails closed: no attestation, no engine, a digest mismatch or an exhausted tenant quota all stop before
 * any process is created. Timeouts and output or memory overruns kill the whole process group and reap it.
 */
export async function runIsolatedPineIndicator({ tenantId, request, engine, sandbox, limits = {} }) {
  if (!sandbox || sandbox.attestation !== DEV_HARNESS_ATTESTATION) {
    fail("SANDBOX_NOT_ATTESTED", "The Pine worker requires an attested OS sandbox; none is configured.");
  }
  if (typeof tenantId !== "string" || !TENANT.test(tenantId)) {
    fail("INVALID_TENANT", "The tenant identifier is missing or malformed.");
  }
  if (!engine || typeof engine.path !== "string" || !engine.path.startsWith("/") ||
      typeof engine.sha256 !== "string" || !SHA256.test(engine.sha256)) {
    fail("ENGINE_UNAVAILABLE", "No pinned Pine engine is configured for the worker.");
  }
  const L = Object.freeze({ ...WORKER_LIMITS, ...limits });
  const body = JSON.stringify(request ?? null);
  if (typeof body !== "string" || Buffer.byteLength(body) > L.requestBytes) {
    fail("INVALID_REQUEST", "The worker request is missing or larger than the configured limit.");
  }
  const running = active.get(tenantId) ?? 0;
  if (running >= L.maxConcurrentPerTenant) {
    fail("QUOTA_EXCEEDED", "This tenant already has the maximum number of Pine worker runs in progress.");
  }
  active.set(tenantId, running + 1);
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "pine-worker-"));
    return await runChild({ dir, body, engine, limits: L });
  } finally {
    const left = (active.get(tenantId) ?? 1) - 1;
    if (left > 0) active.set(tenantId, left);
    else active.delete(tenantId);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runChild({ dir, body, engine, limits }) {
  const args = [
    "--permission",
    `--allow-fs-read=${PACKAGE_DIR}/*`,
    `--allow-fs-read=${engine.path}`,
    `--max-old-space-size=${limits.heapMb}`,
    "--disallow-code-generation-from-strings",
    CHILD_ENTRY,
    engine.path,
    engine.sha256,
  ];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: CHILD_ENV,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    const out = [];
    let outBytes = 0;
    let verdict = null;
    let settled = false;

    const kill = (reason) => {
      if (verdict) return;
      verdict = reason;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => kill("TIMEOUT"), limits.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > limits.responseBytes) return kill("OUTPUT_LIMIT");
      out.push(chunk);
    });
    // Diagnostics are discarded: they can contain engine internals and are never returned to callers.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(body);

    child.on("error", () => {
      settle(() => reject(workerError("WORKER_CRASHED", "The Pine worker process could not start.")));
    });
    child.on("close", (code, signal) => {
      settle(() => {
        const details = { pid: child.pid, signal: verdict ? "SIGKILL" : signal ?? null, code: code ?? null };
        if (verdict === "TIMEOUT") return reject(workerError("TIMEOUT", "The Pine worker exceeded its time limit and was killed.", details));
        if (verdict === "OUTPUT_LIMIT") return reject(workerError("OUTPUT_LIMIT", "The Pine worker produced more output than allowed.", details));
        const reply = parseReply(Buffer.concat(out).toString("utf8"));
        if (!reply) return reject(workerError("WORKER_CRASHED", "The Pine worker exited without a result.", details));
        if (!reply.ok) return reject(workerError(knownEngineCode(reply.code), String(reply.message ?? "The Pine engine failed.").slice(0, 200)));
        resolve(reply.result);
      });
    });

    // A child that does not exit after its kill is reported, not waited on forever.
    const guard = setTimeout(() => {
      if (!settled && verdict) {
        settled = true;
        reject(workerError("KILL_FAILED", "The Pine worker did not exit after it was killed."));
      }
    }, limits.timeoutMs + limits.killGraceMs);
    guard.unref?.();
  });
}

const ENGINE_CODES = new Set([
  "ENGINE_FAILURE", "ENGINE_DIGEST_MISMATCH", "ENGINE_UNAVAILABLE", "INVALID_REQUEST", "INVALID_SOURCE",
  "INVALID_BARS", "INVALID_OUTPUT", "UNSUPPORTED_SCRIPT", "UNSUPPORTED_VERSION", "UNSUPPORTED_DATA_REQUEST",
  "UNSUPPORTED_PLOT_STYLE", "MISSING_EVIDENCE",
]);

// Engine-reported codes are copied only from this list; anything else is reported as a generic engine failure.
function knownEngineCode(code) {
  return ENGINE_CODES.has(code) ? code : "ENGINE_FAILURE";
}

function workerError(code, message, details) {
  const error = new PinePluginError(code, message);
  if (details) error.details = Object.freeze({ ...details });
  return error;
}

function parseReply(text) {
  const line = text.trim().split("\n").pop();
  if (!line) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function activeWorkerRuns(tenantId) {
  return active.get(tenantId) ?? 0;
}

export function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
