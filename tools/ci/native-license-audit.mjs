#!/usr/bin/env node
// Validate installed license metadata against the lock and exact runtime-exclusion inventory.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareRuntimeExcludedInventory,
  isRuntimeExcludedPackageName,
  isKnownRuntimeExcludedSpdxExpression,
  isPermissiveSpdxExpression,
  packageNameFromLockPath,
  parseSpdxExpression,
} from "./native-license-policy.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const appRoot = path.join(repositoryRoot, "apps/eqoboard-web");
const lockPath = path.join(appRoot, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const inventory = JSON.parse(readFileSync(path.join(toolDirectory, "native-runtime-excluded-license-inventory.json"), "utf8"));
const failures = [];
const records = [];

function fail(target, reason, details = {}) {
  failures.push({ path: target, reason, ...details });
}

if (inventory.schemaVersion !== 1 || inventory.kind !== "native-runtime-excluded-license-inventory" ||
    inventory.lockfile !== "apps/eqoboard-web/package-lock.json" || !Array.isArray(inventory.packages)) {
  throw new Error("invalid native runtime-exclusion license inventory header");
}

const inventoryComparison = compareRuntimeExcludedInventory(lock.packages ?? {}, inventory.packages);
failures.push(...inventoryComparison.failures);
const inventoryByPath = inventoryComparison.inventoryByPath;

for (const [relative, metadata] of Object.entries(lock.packages ?? {})) {
  if (!relative) continue;
  if (!relative.startsWith("node_modules/") || relative.split("/").some((part) => part === "..")) {
    fail(relative, "non-install package path");
    continue;
  }

  const packageName = packageNameFromLockPath(relative);
  const runtimeExcluded = isRuntimeExcludedPackageName(packageName ?? "");
  const reviewed = inventoryByPath.get(relative);
  if (!runtimeExcluded && reviewed) {
    fail(relative, "inventory contains a package outside the approved runtime-excluded families");
  }

  let installed;
  try {
    installed = JSON.parse(readFileSync(path.join(appRoot, relative, "package.json"), "utf8"));
  } catch (error) {
    // npm omits optional packages for non-matching platforms, but their complete lock metadata remains reviewed.
    if (error.code === "ENOENT" && metadata.optional === true) {
      const license = metadata.license ?? null;
      if (typeof license !== "string" || !parseSpdxExpression(license)) {
        fail(relative, "invalid or missing optional-package SPDX expression", { license });
      } else if (runtimeExcluded ? !isKnownRuntimeExcludedSpdxExpression(license) : !isPermissiveSpdxExpression(license)) {
        fail(relative, runtimeExcluded ? "unreviewed runtime-excluded license expression" : "unreviewed optional license", { license });
      }
      records.push({ path: relative, name: packageName, version: metadata.version, integrity: metadata.integrity ?? null, license, notices: [], installed: false, scope: runtimeExcluded ? reviewed?.scope ?? null : null });
      continue;
    }
    throw error;
  }

  const license = typeof installed.license === "string" ? installed.license : installed.license?.type;
  const notices = readdirSync(path.join(appRoot, relative)).filter((name) => /^(?:licen[sc]e|notice|copying)(?:[._-]|$)/iu.test(name));
  records.push({ path: relative, name: installed.name, version: installed.version, integrity: metadata.integrity ?? null, license: license ?? null, notices, installed: true, scope: runtimeExcluded ? reviewed?.scope ?? null : null });

  if (installed.name !== packageName) fail(relative, "installed package name differs from lock path", { expected: packageName, actual: installed.name });
  if (metadata.version && installed.version !== metadata.version) fail(relative, "installed version differs from lock", { expected: metadata.version, actual: installed.version });
  if (typeof license !== "string" || !parseSpdxExpression(license)) {
    fail(relative, "invalid or missing SPDX expression", { license: license ?? null });
  } else if (metadata.license !== license) {
    fail(relative, "installed SPDX expression differs from lock", { locked: metadata.license ?? null, installed: license });
  } else if (runtimeExcluded ? !isKnownRuntimeExcludedSpdxExpression(license) : !isPermissiveSpdxExpression(license)) {
    fail(relative, runtimeExcluded ? "unreviewed runtime-excluded license expression" : "unreviewed or non-permissive SPDX expression", { license });
  }
}

for (const filename of ["legal/EQOBOARD-LICENSE-MIT", "legal/OPENTERMINAL-LICENSE-MIT"]) {
  const notice = readFileSync(path.join(appRoot, filename), "utf8");
  if (!notice.includes("Permission is hereby granted") || !notice.toLowerCase().includes("copyright")) {
    fail(filename, "complete MIT notice text was not found");
  }
}

const report = {
  schemaVersion: 2,
  kind: "native-dependency-license-audit",
  acceptance: "lock-metadata-spdx-syntax-runtime-exclusion-inventory-and-notice-audit-not-provider-data-rights",
  inventory: path.relative(repositoryRoot, path.join(toolDirectory, "native-runtime-excluded-license-inventory.json")),
  records,
  failures,
};
const output = path.join(process.env.RUNNER_TEMP ?? appRoot, "native-license-audit.json");
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`License metadata reviewed: ${records.length}; runtime-exclusion inventory: ${inventoryByPath.size}; blocking findings: ${failures.length}`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
