import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findForbiddenRuntimeArtifacts } from "../../apps/eqoboard-web/tools/ci/native-runtime-package-audit.mjs";

function withArtifact(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-runtime-audit-"));
  try { run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function addPackage(root, relative) {
  const directory = path.join(root, relative);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), "{}\n");
}

test("runtime artifact audit detects sharp and native libvips packages", () => {
  withArtifact((root) => {
    addPackage(root, "node_modules/sharp");
    addPackage(root, "node_modules/@img/sharp-libvips-linux-x64");
    assert.deepEqual(findForbiddenRuntimeArtifacts(root), [
      "node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/sharp",
    ]);
  });
});

test("runtime artifact audit detects build-only Lightning CSS platform packages", () => {
  withArtifact((root) => {
    addPackage(root, "node_modules/next/node_modules/lightningcss");
    addPackage(root, "node_modules/lightningcss-linux-x64-gnu");
    assert.deepEqual(findForbiddenRuntimeArtifacts(root), [
      "node_modules/lightningcss-linux-x64-gnu",
      "node_modules/next/node_modules/lightningcss",
    ]);
  });
});

test("runtime artifact audit detects known copied Sharp, Lightning CSS, and libvips native names", () => {
  withArtifact((root) => {
    const assets = path.join(root, "server-assets");
    mkdirSync(assets, { recursive: true });
    for (const filename of ["sharp-linux-x64.node", "lightningcss.linux-x64-gnu.node", "libvips-cpp.so.8.17.3"]) {
      writeFileSync(path.join(assets, filename), "native placeholder");
    }
    assert.deepEqual(findForbiddenRuntimeArtifacts(root), [
      "server-assets/libvips-cpp.so.8.17.3 (known optimizer native filename)",
      "server-assets/lightningcss.linux-x64-gnu.node (known optimizer native filename)",
      "server-assets/sharp-linux-x64.node (known optimizer native filename)",
    ]);
  });
});

test("runtime artifact audit fails closed on unresolved and out-of-root symlinks", () => {
  withArtifact((root) => {
    const packageDirectory = path.join(root, "node_modules/other");
    mkdirSync(packageDirectory, { recursive: true });
    const outsideDirectory = mkdtempSync(path.join(os.tmpdir(), "native-runtime-outside-"));
    try {
      const outsideFile = path.join(outsideDirectory, "payload.bin");
      writeFileSync(outsideFile, "outside artifact");
      symlinkSync(outsideFile, path.join(packageDirectory, "external-link"));
      symlinkSync(path.join(root, "missing-target"), path.join(root, "broken-link"));
      assert.deepEqual(findForbiddenRuntimeArtifacts(root), [
        "broken-link (unresolved symlink)",
        "node_modules/other/external-link (symlink escapes artifact root)",
      ]);
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });
});

test("runtime artifact audit does not allow symlinks into the preserved legal archive", () => {
  withArtifact((root) => {
    const legalDirectory = path.join(root, "legal/dependencies");
    mkdirSync(legalDirectory, { recursive: true });
    writeFileSync(path.join(legalDirectory, "LICENSE"), "license text");
    symlinkSync(legalDirectory, path.join(root, "runtime-license-link"), "dir");
    assert.deepEqual(findForbiddenRuntimeArtifacts(root), [
      "runtime-license-link (symlink targets license-only archive)",
    ]);
  });
});

test("runtime artifact audit ignores preserved legal-text copies and unrelated runtime packages", () => {
  withArtifact((root) => {
    addPackage(root, "node_modules/react");
    const legalCopy = path.join(root, "legal/dependencies/node_modules/sharp");
    mkdirSync(legalCopy, { recursive: true });
    writeFileSync(path.join(legalCopy, "LICENSE"), "Full source license text\n");
    writeFileSync(path.join(root, "legal/dependencies/libvips-cpp.so.8.17.3"), "source license archive path");
    assert.deepEqual(findForbiddenRuntimeArtifacts(root), []);
  });
});
