// Child entry for the isolated Pine worker. It runs under `node --permission` with an empty environment,
// reads exactly one bounded JSON request on stdin, verifies the pinned engine digest, evaluates the
// read-only indicator and writes exactly one JSON line to stdout. It has no network, service or broker code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PinePluginError } from "./contract.mjs";
import { runReadOnlyPineIndicator } from "./runtime.mjs";

const REQUEST_LIMIT = 1_048_576;
const [, , enginePath = "", expectedSha = ""] = process.argv;

function reply(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function refuse(code, message) {
  reply({ ok: false, code, message });
}

function readRequest() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > REQUEST_LIMIT) {
        reject(new PinePluginError("INVALID_REQUEST", "The worker request exceeds the configured limit."));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => reject(new PinePluginError("INVALID_REQUEST", "The worker request could not be read.")));
  });
}

async function main() {
  const bytes = readFileSync(enginePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha) {
    return refuse("ENGINE_DIGEST_MISMATCH", "The Pine engine does not match its pinned digest.");
  }
  const request = JSON.parse(await readRequest());
  if (!request || typeof request !== "object") {
    return refuse("INVALID_REQUEST", "The worker request is not an object.");
  }
  const module = await import(pathToFileURL(enginePath).href);
  const result = await runReadOnlyPineIndicator({
    source: request.source,
    bars: request.bars,
    evidence: request.evidence,
    engine: module.default,
  });
  reply({ ok: true, result });
}

main().catch((error) => {
  if (error instanceof PinePluginError) {
    refuse(error.code, error.message);
  } else {
    // Engine internals (stack traces, paths) are never copied into the reply.
    refuse("ENGINE_FAILURE", "The Pine engine raised an error.");
  }
});
