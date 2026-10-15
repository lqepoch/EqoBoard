#!/usr/bin/env node
// Audit installed metadata against the committed graph; image notices are retained separately.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/eqoboard-web");
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const allowed = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense",
  "CC0-1.0", "CC-BY-4.0", "Python-2.0", "BlueOak-1.0.0", "Zlib", "WTFPL",
]);
function allowedExpression(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  const tokens = value.replace(/[()]/gu, " ").trim().split(/\s+/u);
  return tokens.length > 0 && tokens.some((token) => allowed.has(token)) &&
    tokens.every((token) => token === "OR" || token === "AND" || allowed.has(token));
}
const records = [];
const failures = [];
for (const [relative, metadata] of Object.entries(lock.packages ?? {})) {
  if (!relative) continue;
  if (!relative.startsWith("node_modules/") || relative.split("/").some((part) => part === "..")) {
    failures.push({ path: relative, reason: "non-install package path" });
    continue;
  }
  let installed;
  try { installed = JSON.parse(readFileSync(path.join(root, relative, "package.json"), "utf8")); }
  catch (error) {
    // Platform-excluded optional packages remain in the reviewed lock metadata.
    if (error.code === "ENOENT" && metadata.optional === true) {
      records.push({ path: relative, version: metadata.version, license: metadata.license ?? null, installed: false });
      if (!allowedExpression(metadata.license)) failures.push({ path: relative, reason: "unreviewed optional license" });
      continue;
    }
    throw error;
  }
  const license = typeof installed.license === "string" ? installed.license : installed.license?.type;
  const notices = readdirSync(path.join(root, relative)).filter((name) => /^(?:licen[sc]e|notice|copying)(?:[._-]|$)/iu.test(name));
  records.push({ path: relative, name: installed.name, version: installed.version, license: license ?? null, notices, installed: true });
  if (!allowedExpression(license)) failures.push({ path: relative, reason: "unreviewed or missing SPDX expression", license: license ?? null });
  if (metadata.version && installed.version !== metadata.version) failures.push({ path: relative, reason: "installed version differs from lock" });
}
for (const filename of ["legal/EQOBOARD-LICENSE-MIT", "legal/OPENTERMINAL-LICENSE-MIT"]) {
  const notice = readFileSync(path.join(root, filename), "utf8");
  if (!notice.includes("Permission is hereby granted") || !notice.includes("copyright")) throw new Error("missing complete MIT notice: " + filename);
}
const report = { schemaVersion: 1, kind: "native-dependency-license-audit", acceptance: "metadata-and-notice-audit-not-provider-data-rights", records, failures };
const output = path.join(process.env.RUNNER_TEMP ?? root, "native-license-audit.json");
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`License metadata reviewed: ${records.length}; blocking findings: ${failures.length}`);
if (failures.length) { console.error(JSON.stringify(failures)); process.exitCode = 1; }
