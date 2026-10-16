#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const PRIVATE_ABSOLUTE_PATH = /(?:^|[\s"'(])\/(?:Users|home|Volumes)\/[^\s"'<>]*/u;
const SOURCE_PATH_FIELDS = new Set(["nativePath", "noticePath", "path", "sourcePath"]);
const SOURCE_PATH_LIST_FIELDS = new Set(["independent_native_modules", "nativePaths", "paths", "sourcePaths"]);

export function collectNativeSourceFiles(repositoryRoot) {
  const nativeRoot = path.resolve(repositoryRoot, "apps/eqoboard-web");
  const files = [];
  const issues = [];

  function visit(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      issues.push("cannot-read-native-source-directory: " + path.relative(repositoryRoot, directory));
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      let stat;
      try {
        stat = lstatSync(absolutePath);
      } catch {
        issues.push("cannot-stat-native-source-entry: " + path.relative(repositoryRoot, absolutePath));
        continue;
      }
      if (stat.isSymbolicLink()) {
        issues.push("symbolic-link-in-native-source-tree: " + path.relative(repositoryRoot, absolutePath));
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (stat.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.relative(repositoryRoot, absolutePath).split(path.sep).join("/"));
      }
    }
  }

  visit(nativeRoot);
  return { files: files.sort(), issues };
}

function collectStringValues(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      collectStringValues(item, output);
    }
  }
  return output;
}

function collectSourcePathEntries(value, location = "document", output = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectSourcePathEntries(value[index], location + "[" + index + "]", output);
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SOURCE_PATH_FIELDS.has(key) && typeof item === "string") {
        output.push({ location: location + "." + key, value: item });
      } else if (SOURCE_PATH_LIST_FIELDS.has(key) && Array.isArray(item)) {
        for (let index = 0; index < item.length; index += 1) {
          if (typeof item[index] === "string") {
            output.push({ location: location + "." + key + "[" + index + "]", value: item[index] });
          } else {
            collectSourcePathEntries(item[index], location + "." + key + "[" + index + "]", output);
          }
        }
      } else {
        collectSourcePathEntries(item, location + "." + key, output);
      }
    }
  }
  return output;
}

function hasUnverifiedStatus(value, location = "document") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => hasUnverifiedStatus(item, location + "[" + index + "]"));
  }
  if (!value || typeof value !== "object") return [];

  const issues = [];
  for (const [key, item] of Object.entries(value)) {
    if (
      ["status", "sourceStatus", "classification"].includes(key) &&
      typeof item === "string" &&
      /^UNVERIFIED(?:\b|:)/iu.test(item.trim())
    ) {
      issues.push(location + "." + key + " is UNVERIFIED");
    }
    issues.push(...hasUnverifiedStatus(item, location + "." + key));
  }
  return issues;
}

function resolveOwnerRecords(document) {
  const records = Array.isArray(document.records) ? [...document.records] : [];
  if (document.rootIntegration && typeof document.rootIntegration === "object") {
    records.push({
      ...document.rootIntegration,
      agent: document.rootIntegration.agent || "native_root_integration",
    });
  }
  return records;
}

export function validateNativeSourceProvenance(document, repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const issues = [];

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, issues: ["provenance-document-must-be-an-object"], sourceFiles: [] };
  }

  const strings = collectStringValues(document);
  for (const value of strings) {
    if (PRIVATE_ABSOLUTE_PATH.test(value)) {
      issues.push("private-absolute-path-present-in-public-provenance");
      break;
    }
  }
  issues.push(...hasUnverifiedStatus(document));
  if (document.unverified !== undefined && !Array.isArray(document.unverified)) {
    issues.push("unverified-provenance-must-be-an-array");
  } else if (Array.isArray(document.unverified)) {
    for (const entry of document.unverified) {
      if (entry && typeof entry === "object" && entry.blocking !== false) {
        issues.push("blocking-unverified-provenance: " + String(entry.path || "unspecified path"));
      }
    }
  }

  if (!Array.isArray(document.records) || document.records.length === 0) {
    issues.push("provenance-records-must-be-a-non-empty-array");
  }
  if (!document.rootIntegration || typeof document.rootIntegration !== "object") {
    issues.push("root-integration-owner-record-required");
  }

  const records = resolveOwnerRecords(document);
  const ownerNames = new Set();
  const pathOwners = new Map();
  for (const record of records) {
    const owner = record && typeof record.agent === "string" ? record.agent.trim() : "";
    if (!owner) {
      issues.push("owner-record-missing-agent");
    } else if (ownerNames.has(owner)) {
      issues.push("duplicate-owner-record: " + owner);
    } else {
      ownerNames.add(owner);
    }
    if (
      !record ||
      !record.source_provenance ||
      typeof record.source_provenance !== "object" ||
      typeof record.source_provenance.classification !== "string" ||
      record.source_provenance.classification.trim().length === 0
    ) {
      issues.push("owner-record-missing-source-classification: " + (owner || "unknown"));
    }

    if (!record || !Array.isArray(record.files) || record.files.length === 0) {
      issues.push("empty-owner-file-list: " + (owner || "unknown"));
      continue;
    }
    if (record.auditSources !== undefined && !Array.isArray(record.auditSources)) {
      issues.push("audit-sources-must-be-an-array: " + owner);
    } else {
      for (const auditPath of record.auditSources || []) {
        if (
          typeof auditPath !== "string" ||
          auditPath.length === 0 ||
          path.posix.isAbsolute(auditPath) ||
          path.win32.isAbsolute(auditPath) ||
          auditPath.endsWith("/") ||
          path.posix.normalize(auditPath) !== auditPath ||
          auditPath.includes("\\")
        ) {
          issues.push("invalid-audit-source-path: " + String(auditPath));
          continue;
        }
        const absoluteAuditPath = path.resolve(root, auditPath);
        if (!absoluteAuditPath.startsWith(root + path.sep)) {
          issues.push("audit-source-path-escapes-repository: " + auditPath);
          continue;
        }
        try {
          const stat = lstatSync(absoluteAuditPath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            issues.push("audit-source-path-is-not-a-regular-file: " + auditPath);
          }
        } catch {
          issues.push("audit-source-path-does-not-exist: " + auditPath);
        }
      }
    }

    const localPaths = new Set();
    for (const filePath of record.files) {
      if (typeof filePath !== "string" || filePath.length === 0) {
        issues.push("invalid-owner-path: " + (owner || "unknown"));
        continue;
      }
      if (
        path.posix.isAbsolute(filePath) ||
        path.win32.isAbsolute(filePath) ||
        filePath.endsWith("/") ||
        filePath.includes("\\")
      ) {
        issues.push("absolute-or-directory-only-owner-path: " + filePath);
        continue;
      }
      const normalized = path.posix.normalize(filePath);
      if (normalized !== filePath || normalized === ".." || normalized.startsWith("../")) {
        issues.push("non-canonical-owner-path: " + filePath);
        continue;
      }
      if (localPaths.has(filePath)) {
        issues.push("duplicate-path-within-owner: " + owner + ": " + filePath);
        continue;
      }
      localPaths.add(filePath);

      const absolutePath = path.resolve(root, filePath);
      if (!absolutePath.startsWith(root + path.sep)) {
        issues.push("owner-path-escapes-repository: " + filePath);
        continue;
      }
      let stat;
      try {
        stat = lstatSync(absolutePath);
      } catch {
        issues.push("owner-path-does-not-exist: " + filePath);
        continue;
      }
      if (stat.isSymbolicLink()) {
        issues.push("owner-path-is-symbolic-link: " + filePath);
      } else if (!stat.isFile()) {
        issues.push("owner-path-is-not-a-file: " + filePath);
      }

      const priorOwners = pathOwners.get(filePath) || [];
      priorOwners.push(owner || "unknown");
      pathOwners.set(filePath, priorOwners);
    }
  }

  for (const [filePath, owners] of pathOwners) {
    if (owners.length !== 1) {
      issues.push("source-path-must-have-exactly-one-owner: " + filePath + " (" + owners.join(", ") + ")");
    }
  }

  for (const entry of collectSourcePathEntries(document)) {
    const filePath = entry.value;
    if (
      filePath.length === 0 ||
      path.posix.isAbsolute(filePath) ||
      path.win32.isAbsolute(filePath) ||
      filePath.endsWith("/") ||
      filePath.includes("\\") ||
      path.posix.normalize(filePath) !== filePath
    ) {
      issues.push("invalid-source-reference-path: " + entry.location + ": " + filePath);
      continue;
    }
    const absolutePath = path.resolve(root, filePath);
    if (!absolutePath.startsWith(root + path.sep)) {
      issues.push("source-reference-path-escapes-repository: " + entry.location + ": " + filePath);
      continue;
    }
    try {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        issues.push("source-reference-path-is-not-a-regular-file: " + entry.location + ": " + filePath);
      }
    } catch {
      issues.push("source-reference-path-does-not-exist: " + entry.location + ": " + filePath);
    }
  }

  const inventory = collectNativeSourceFiles(root);
  issues.push(...inventory.issues);
  for (const filePath of inventory.files) {
    const owners = pathOwners.get(filePath) || [];
    if (owners.length === 0) issues.push("unowned-native-source-file: " + filePath);
    if (owners.length > 1) {
      issues.push("native-source-file-has-multiple-owners: " + filePath + " (" + owners.join(", ") + ")");
    }
  }

  return { ok: issues.length === 0, issues, sourceFiles: inventory.files };
}

export function auditNativeSourceProvenance(repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot);
  const provenancePath = path.join(root, "docs/migration/NATIVE_SOURCE_PROVENANCE.json");
  let document;
  try {
    document = JSON.parse(readFileSync(provenancePath, "utf8"));
  } catch {
    return { ok: false, issues: ["cannot-read-or-parse-docs/migration/NATIVE_SOURCE_PROVENANCE.json"], sourceFiles: [] };
  }
  return validateNativeSourceProvenance(document, root);
}

function main() {
  const result = auditNativeSourceProvenance(process.argv[2] || process.cwd());
  if (result.ok) {
    process.stdout.write("Native source provenance audit: PASS (" + result.sourceFiles.length + " source files)\n");
    return;
  }
  process.stderr.write("Native source provenance audit: FAIL\n");
  for (const issue of result.issues) process.stderr.write("- " + issue + "\n");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
