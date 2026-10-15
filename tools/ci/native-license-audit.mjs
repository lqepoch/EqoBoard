#!/usr/bin/env node
// Validate lock metadata and pinned license texts. Runtime legal clearance is a separate image-bound gate.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const REQUIRED_NOTICE_PACKAGES = new Set([
  "node_modules/@bufbuild/protobuf",
  "node_modules/@next/env",
  "node_modules/@nodable/entities",
  "node_modules/fancy-canvas",
  "node_modules/next-auth",
]);
const NOTICE_FILENAME = /^(?:licen[sc]e|notice|copying)(?:[._-]|$)/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

/** Recursively list package license/notice files without following package symlinks. */
export function enumerateNoticeArtifacts(packageRoot) {
  const root = path.resolve(packageRoot);
  const found = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (NOTICE_FILENAME.test(entry.name)) {
          found.push({
            path: path.relative(root, filePath).split(path.sep).join("/"),
            sha256: null,
            bytes: null,
            symlink: true,
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && NOTICE_FILENAME.test(entry.name)) {
        const bytes = readFileSync(filePath);
        found.push({
          path: path.relative(root, filePath).split(path.sep).join("/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
          symlink: false,
        });
      }
    }
  }

  walk(root);
  return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function validRelativeFile(root, value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return null;
  if (value.split(/[\\/]/u).some((part) => part === ".." || part === "")) return null;
  const absolute = path.resolve(root, value);
  return absolute.startsWith(`${root}${path.sep}`) ? absolute : null;
}

function runAudit() {
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
        records.push({ path: relative, name: packageName, version: metadata.version, integrity: metadata.integrity ?? null, license, notices: [], noticeFiles: [], installed: false, scope: runtimeExcluded ? reviewed?.scope ?? null : null });
        continue;
      }
      throw error;
    }

    const license = typeof installed.license === "string" ? installed.license : installed.license?.type;
    const noticeFiles = enumerateNoticeArtifacts(path.join(appRoot, relative));
    for (const notice of noticeFiles) {
      if (notice.symlink) fail(`${relative}/${notice.path}`, "license or notice symlink was not followed");
    }
    records.push({
      path: relative,
      name: installed.name,
      version: installed.version,
      integrity: metadata.integrity ?? null,
      license: license ?? null,
      notices: noticeFiles.map((notice) => notice.path),
      noticeFiles,
      installed: true,
      scope: runtimeExcluded ? reviewed?.scope ?? null : null,
    });

    if (installed.name !== packageName) fail(relative, "installed package name differs from lock path", { expected: packageName, actual: installed.name });
    if (metadata.version && installed.version !== metadata.version) fail(relative, "installed package version differs from lock", { expected: metadata.version, installed: installed.version });
    if (typeof license !== "string" || !parseSpdxExpression(license)) {
      fail(relative, "invalid or missing SPDX expression", { license: license ?? null });
    } else if (metadata.license !== license) {
      fail(relative, "installed SPDX expression differs from lock", { locked: metadata.license ?? null, installed: license });
    } else if (runtimeExcluded ? !isKnownRuntimeExcludedSpdxExpression(license) : !isPermissiveSpdxExpression(license)) {
      fail(relative, runtimeExcluded ? "unreviewed runtime-excluded license expression" : "unreviewed or non-permissive SPDX expression", { license });
    }
  }

  const noticeRecordPath = path.join(appRoot, "legal/third-party/NOTICE-RECORDS.json");
  let noticeRecord = null;
  try {
    noticeRecord = JSON.parse(readFileSync(noticeRecordPath, "utf8"));
  } catch (error) {
    fail("legal/third-party/NOTICE-RECORDS.json", "pinned third-party notice record is missing or invalid JSON", { error: error.message });
  }

  let verifiedSourceTexts = 0;
  if (noticeRecord) {
    if (noticeRecord.schemaVersion !== 1 || noticeRecord.kind !== "native-third-party-license-text-record" || !Array.isArray(noticeRecord.packages)) {
      fail("legal/third-party/NOTICE-RECORDS.json", "unsupported pinned third-party notice record");
    }
    const legalRoot = path.resolve(appRoot, "legal/third-party");
    const packageRecords = new Map();
    for (const item of noticeRecord.packages ?? []) {
      if (!item || typeof item.packagePath !== "string" || packageRecords.has(item.packagePath)) {
        fail("legal/third-party/NOTICE-RECORDS.json", "invalid or duplicate package notice record", { packagePath: item?.packagePath ?? null });
        continue;
      }
      packageRecords.set(item.packagePath, item);
    }

    for (const requiredPath of REQUIRED_NOTICE_PACKAGES) {
      if (!packageRecords.has(requiredPath)) fail(requiredPath, "confirmed production package is missing its pinned license-text record");
    }
    for (const [packagePath, item] of packageRecords) {
      const metadata = lock.packages?.[packagePath];
      if (!REQUIRED_NOTICE_PACKAGES.has(packagePath)) fail(packagePath, "stale or unreviewed package notice record");
      if (!metadata) {
        fail(packagePath, "package notice record is not present in the lockfile");
        continue;
      }
      if (item.packageName !== packageNameFromLockPath(packagePath) || item.packageVersion !== metadata.version ||
          item.packageIntegrity !== metadata.integrity || item.originalSpdxExpression !== metadata.license) {
        fail(packagePath, "package notice record differs from locked name, version, bytes, or SPDX expression", {
          expected: { name: packageNameFromLockPath(packagePath), version: metadata.version, integrity: metadata.integrity, license: metadata.license },
          actual: { name: item.packageName, version: item.packageVersion, integrity: item.packageIntegrity, license: item.originalSpdxExpression },
        });
      }
      if (!COMMIT.test(item.sourceCommit ?? "") || typeof item.repository !== "string" || !item.repository.startsWith("https://") ||
          !Array.isArray(item.sourceFiles) || item.sourceFiles.length === 0) {
        fail(packagePath, "package notice record lacks a pinned source commit, repository, or source files");
      }
      for (const source of item.sourceFiles ?? []) {
        if (!source || !COMMIT.test(item.sourceCommit ?? "") || !SHA256.test(source.sourceSha256 ?? "") ||
            typeof source.sourcePath !== "string" || !source.sourcePath ||
            typeof source.sourceUrl !== "string" || !source.sourceUrl.startsWith("https://") || !source.sourceUrl.includes(item.sourceCommit) ||
            typeof source.spdxLicense !== "string" || !parseSpdxExpression(source.spdxLicense)) {
          fail(packagePath, "source notice entry lacks a valid URL, SHA-256, commit, or SPDX identifier");
          continue;
        }
        const artifact = source.textArtifact;
        const artifactPath = validRelativeFile(legalRoot, artifact?.path);
        if (!artifactPath || !SHA256.test(artifact?.sha256 ?? "")) {
          fail(packagePath, "license text artifact path or hash is invalid", { artifact: artifact ?? null });
          continue;
        }
        try {
          const stat = lstatSync(artifactPath);
          if (!stat.isFile()) throw new Error("license artifact is not a regular file");
          const bytes = readFileSync(artifactPath);
          const actualHash = createHash("sha256").update(bytes).digest("hex");
          if (actualHash !== artifact.sha256 || bytes.byteLength !== artifact.bytes) {
            fail(artifact.path, "license text artifact hash or byte length differs from receipt", {
              expectedSha256: artifact.sha256,
              actualSha256: actualHash,
              expectedBytes: artifact.bytes,
              actualBytes: bytes.byteLength,
            });
          } else {
            verifiedSourceTexts += 1;
          }
        } catch (error) {
          fail(artifact.path, "license text artifact is missing or unreadable", { error: error.message });
        }
      }
    }

    const gate = noticeRecord.runtimeNoticeGate;
    if (!gate || !["BLOCKED", "PASS"].includes(gate.status) || !Array.isArray(gate.blockers)) {
      fail("legal/third-party/NOTICE-RECORDS.json", "runtime notice gate must have an explicit status and blocker list");
    } else if (gate.status === "PASS" && gate.blockers.some((blocker) => blocker.status === "BLOCKED")) {
      fail("legal/third-party/NOTICE-RECORDS.json", "runtime notice gate cannot be PASS while blocked items remain");
    }
  }

  for (const filename of ["legal/EQOBOARD-LICENSE-MIT", "legal/OPENTERMINAL-LICENSE-MIT"]) {
    const notice = readFileSync(path.join(appRoot, filename), "utf8");
    if (!notice.includes("Permission is hereby granted") || !notice.toLowerCase().includes("copyright")) {
      fail(filename, "complete MIT notice text was not found");
    }
  }

  const report = {
    schemaVersion: 3,
    kind: "native-dependency-license-audit",
    acceptance: "lock-metadata-spdx-syntax-runtime-exclusion-inventory-and-pinned-notice-text-integrity-not-runtime-license-clearance",
    inventory: path.relative(repositoryRoot, path.join(toolDirectory, "native-runtime-excluded-license-inventory.json")),
    noticeRecord: "apps/eqoboard-web/legal/third-party/NOTICE-RECORDS.json",
    verifiedSourceTexts,
    runtimeNoticeGate: noticeRecord?.runtimeNoticeGate ?? { status: "BLOCKED", blockers: [{ id: "notice-record-unavailable", status: "BLOCKED" }] },
    records,
    failures,
  };
  const output = path.join(process.env.RUNNER_TEMP ?? appRoot, "native-license-audit.json");
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  const blockerCount = report.runtimeNoticeGate.blockers?.filter((item) => item.status === "BLOCKED").length ?? 0;
  console.log(`License metadata reviewed: ${records.length}; pinned source texts verified: ${verifiedSourceTexts}; runtime notice gate: ${report.runtimeNoticeGate.status} (${blockerCount} blockers); audit findings: ${failures.length}`);
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAudit();
