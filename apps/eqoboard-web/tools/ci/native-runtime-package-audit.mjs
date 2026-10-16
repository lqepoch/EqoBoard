#!/usr/bin/env node
import { lstatSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isForbiddenRuntimePackage(name) {
  return (
    name === "sharp" ||
    name.startsWith("@img/sharp-") ||
    name === "lightningcss" ||
    name.startsWith("lightningcss-")
  );
}

function isKnownOptimizerNativeName(name) {
  return (
    /^sharp(?:[-.][A-Za-z0-9._-]+)?\.node$/iu.test(name) ||
    /^lightningcss(?:[-.][A-Za-z0-9._-]+)?\.node$/iu.test(name) ||
    /^libvips(?:[-_.][A-Za-z0-9._-]+)?\.(?:so(?:\.[A-Za-z0-9._-]+)?|dylib|dll)$/iu.test(name) ||
    /^libvips(?:[-_.][A-Za-z0-9._-]+)?$/iu.test(name)
  );
}

function packageRootName(relativeParts) {
  const index = relativeParts.lastIndexOf("node_modules");
  if (index < 0) return null;
  const remaining = relativeParts.length - index - 1;
  if (remaining === 1 && !relativeParts[index + 1].startsWith("@")) return relativeParts[index + 1];
  if (remaining === 2 && relativeParts[index + 1].startsWith("@"))
    return `${relativeParts[index + 1]}/${relativeParts[index + 2]}`;
  return null;
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** Return known optimizer/build-transform package or native-artifact paths found under a runtime root. */
export function findForbiddenRuntimeArtifacts(artifactRoot) {
  const root = path.resolve(artifactRoot);
  if (!lstatSync(root).isDirectory())
    throw new Error(`runtime artifact root is not a directory: ${root}`);
  const pending = [{ absolute: root, relative: "" }];
  const findings = [];

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = readdirSync(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relative = current.relative
        ? path.posix.join(current.relative, entry.name)
        : entry.name;
      // License archives deliberately retain source package notices, not executable package contents.
      if (relative === "legal") {
        if (!entry.isDirectory() || entry.isSymbolicLink())
          findings.push("legal (license archive must be a real directory)");
        continue;
      }
      const absolute = path.join(current.absolute, entry.name);
      if (isKnownOptimizerNativeName(entry.name))
        findings.push(`${relative} (known optimizer native filename)`);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = realpathSync(absolute);
          if (!isWithinRoot(root, resolved))
            findings.push(`${relative} (symlink escapes artifact root)`);
          else if (path.relative(root, resolved).split(path.sep)[0] === "legal")
            findings.push(`${relative} (symlink targets license-only archive)`);
        } catch {
          findings.push(`${relative} (unresolved symlink)`);
        }
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const name = packageRootName(relative.split("/"));
        if (name && isForbiddenRuntimePackage(name)) findings.push(relative);
        if (entry.isDirectory()) pending.push({ absolute, relative });
      }
    }
  }
  return findings.sort();
}

export function auditRuntimeArtifact(artifactRoot) {
  const findings = findForbiddenRuntimeArtifacts(artifactRoot);
  return { ok: findings.length === 0, artifactRoot: path.resolve(artifactRoot), findings };
}

function runCli() {
  const artifactRoot = process.argv[2];
  if (!artifactRoot) {
    console.error("usage: node native-runtime-package-audit.mjs <standalone-or-runtime-app-root>");
    process.exitCode = 2;
    return;
  }
  const result = auditRuntimeArtifact(artifactRoot);
  if (!result.ok) {
    console.error(
      `Forbidden optimizer/build-transform artifacts remain in runtime artifact ${result.artifactRoot}:`,
    );
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Runtime package exclusion verified: ${result.artifactRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
