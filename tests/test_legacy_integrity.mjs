import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BASELINE_COMMIT,
  BASELINE_TREE,
  EXCLUDED_PATHS,
  MERGED_MAIN,
  MUTABLE_SHARED_PATHS,
  PREMERGE_MAIN_PREFLIGHT,
  PROTECTED_FILES,
  SOURCE_TAG,
  compareEntrySets,
  gitBlobSha1,
  inspectWorktreeFile,
  isSafeRelativePath,
  parseLsFilesStage,
  parseLsTree,
  readBoundedManifestFile,
  validateManifestShape,
} from "../tools/migration/legacy-integrity.mjs";

const HASH = "f".repeat(64);

test("source tag, merged main and protected OpenBB implementation facts are pinned", () => {
  assert.equal(BASELINE_COMMIT, "fea1e952add7a11e799d6f9f198ddcee47fd12b6");
  assert.equal(BASELINE_TREE, "986dd808560016965e73edc1869603b621b4286e");
  assert.deepEqual(SOURCE_TAG, {
    tag: "migration/eqoboard-native-source-20261015-fea1e95",
    tagObject: "9d606d11fa95ffa696aa009b52695d2c349f6a97",
    commit: BASELINE_COMMIT,
  });
  assert.deepEqual(MERGED_MAIN, {
    commit: "e5f0f6b7531eb73356eb4059d5cef9e37584b259",
    tree: BASELINE_TREE,
  });
  assert.deepEqual(PREMERGE_MAIN_PREFLIGHT, {
    tag: "migration/eqoboard-native-20261015-740765ec",
    tagObject: "636253df34f3d7d458e4236564db5be153628ad5",
    commit: "740765ec824988eda24822b943c5604f8d565ebf",
  });
  assert.ok(PROTECTED_FILES.includes("apps/gateway/src/openbb.rs"));
  assert.ok(PROTECTED_FILES.includes("tests/test_openbb_upstream_diff.py"));
  assert.equal(MUTABLE_SHARED_PATHS.length, 6);
  assert.ok(MUTABLE_SHARED_PATHS.includes(".github/workflows/openbb.yml"));
  assert.ok(EXCLUDED_PATHS.includes("apps/eqoboard-web"));
  assert.ok(EXCLUDED_PATHS.includes("tests/test_native_build_boundary.py"));
  assert.ok(EXCLUDED_PATHS.includes("tools/native-web-sbom.sh"));
});

function expectedFixture() {
  return {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceTag: { tag: "migration/test-source", tagObject: "c".repeat(40), commit: "a".repeat(40) },
    mergedMain: { commit: "e".repeat(40), tree: "b".repeat(40) },
    premergeMain: { tag: "migration/test-premerge", tagObject: "f".repeat(40), commit: "1".repeat(40) },
    roots: ["legacy"],
    files: [],
    excluded: [],
    mutableShared: [".github/workflows/example.yml"],
  };
}

function validManifestFixture() {
  const expected = expectedFixture();
  return {
    expected,
    manifest: {
      schemaVersion: 2,
      kind: "eqoboard-legacy-integrity-baseline",
      baseline: {
        commit: expected.commit,
        tree: expected.tree,
        objectFormat: "sha1",
        acceptance: "source-tagged-tree-merged-to-main-not-native-parity-or-release-acceptance",
        sourceTag: expected.sourceTag,
        mergedMain: expected.mergedMain,
        premergeMainPreflight: expected.premergeMain,
      },
      scope: {
        protectedRoots: expected.roots,
        protectedFiles: expected.files,
        excludedPaths: expected.excluded,
        mutableSharedPaths: expected.mutableShared,
        coverage: "all tracked files under protectedRoots plus protectedFiles at the pinned source commit",
      },
      fileCount: 1,
      provenance: {},
      licenseArtifacts: ["MIT", "MIT", "Apache-2.0", "NOTICE"].map((license, index) => ({
        path: "legacy/license-" + index,
        license,
        provenanceRef: "legacy-test",
        lockedSha256: null,
        sha256: HASH,
      })),
      files: [{
        path: "legacy/a.ts",
        mode: "100644",
        type: "blob",
        gitBlobOid: "e".repeat(40),
        bytes: 3,
        sha256: HASH,
        featureIds: ["legacy-widget:quote"],
        provenanceRef: "legacy-test",
      }],
    },
  };
}

test("safe paths reject traversal, absolute paths, separators and control bytes", () => {
  assert.equal(isSafeRelativePath("apps/openterminal/web/file.ts"), true);
  assert.equal(isSafeRelativePath("folder name/source.ts"), true);
  assert.equal(isSafeRelativePath("../outside"), false);
  assert.equal(isSafeRelativePath("apps/../outside"), false);
  assert.equal(isSafeRelativePath("/absolute/file"), false);
  assert.equal(isSafeRelativePath("apps\\outside"), false);
  assert.equal(isSafeRelativePath("apps/\u0001file"), false);
  assert.equal(isSafeRelativePath(""), false);
});

test("Git blob SHA-1 is distinct and computed over Git's blob header plus bytes", () => {
  assert.equal(gitBlobSha1(Buffer.from("abc")), "f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f");
  assert.notEqual(gitBlobSha1(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("NUL-delimited tree parser preserves paths containing spaces", () => {
  const oid = gitBlobSha1(Buffer.from("abc"));
  const output = Buffer.from("100644 blob " + oid + " 3\tlegacy/path with spaces.ts\0", "utf8");
  assert.deepEqual(parseLsTree(output), [{
    path: "legacy/path with spaces.ts",
    mode: "100644",
    type: "blob",
    gitBlobOid: oid,
    bytes: 3,
  }]);
});

test("tree parser rejects symlink and non-blob protected entries", () => {
  const oid = "a".repeat(40);
  assert.throws(
    () => parseLsTree(Buffer.from("120000 blob " + oid + " 4\tlegacy/link\0", "utf8")),
    /unsupported protected Git object type or mode/i,
  );
  assert.throws(
    () => parseLsTree(Buffer.from("160000 commit " + oid + " -\tlegacy/submodule\0", "utf8")),
    /unsupported protected Git object type or mode/i,
  );
});

test("index stage parser rejects unmerged entries", () => {
  const output = Buffer.from("100644 " + "a".repeat(40) + " 0\tlegacy/a.ts\0", "utf8");
  assert.equal(parseLsFilesStage(output)[0].stage, 0);
  const conflict = Buffer.from("100644 " + "a".repeat(40) + " 2\tlegacy/a.ts\0", "utf8");
  assert.throws(() => parseLsFilesStage(conflict), /unmerged or unsupported/i);
});

test("baseline coverage comparator accepts exact entries and rejects deletion or changed blobs", () => {
  const entry = {
    path: "legacy/a.ts",
    mode: "100644",
    type: "blob",
    gitBlobOid: "a".repeat(40),
    bytes: 3,
    sha256: HASH,
  };
  assert.deepEqual(compareEntrySets([entry], [{ ...entry }]), []);
  assert.match(compareEntrySets([entry], [])[0], /missing protected path/);
  const changed = compareEntrySets([entry], [{ ...entry, gitBlobOid: "b".repeat(40) }]);
  assert.ok(changed.some((message) => /gitBlobOid mismatch/.test(message)));
  assert.ok(compareEntrySets([entry], [{ ...entry, sha256: "0".repeat(64) }])
    .some((message) => /sha256 mismatch/.test(message)));
});

test("baseline comparator rejects altered feature and provenance attribution", () => {
  const entry = {
    path: "legacy/a.ts",
    mode: "100644",
    type: "blob",
    gitBlobOid: "a".repeat(40),
    bytes: 3,
    sha256: HASH,
    featureIds: ["legacy-widget:quote"],
    provenanceRef: "legacy-source",
  };
  const attributionErrors = compareEntrySets([entry], [{
    ...entry,
    featureIds: ["legacy-widget:orders"],
    provenanceRef: "different-source",
  }]);
  assert.ok(attributionErrors.some((message) => /feature attribution mismatch/.test(message)));
  assert.ok(attributionErrors.some((message) => /provenance reference mismatch/.test(message)));
});

test("manifest validation binds the fixed snapshot, complete scope and sorted unique paths", () => {
  const { expected, manifest } = validManifestFixture();
  assert.equal(validateManifestShape(manifest, expected), true);
  assert.throws(
    () => validateManifestShape({ ...manifest, baseline: { ...manifest.baseline, commit: "0".repeat(40) } }, expected),
    /frozen source snapshot/i,
  );
  assert.throws(
    () => validateManifestShape({ ...manifest, baseline: { ...manifest.baseline, tree: "0".repeat(40) } }, expected),
    /frozen source snapshot/i,
  );
  assert.throws(
    () => validateManifestShape({
      ...manifest,
      baseline: { ...manifest.baseline, sourceTag: { ...manifest.baseline.sourceTag, tagObject: "0".repeat(40) } },
    }, expected),
    /source tag reference/i,
  );
  assert.throws(
    () => validateManifestShape({
      ...manifest,
      scope: { ...manifest.scope, mutableSharedPaths: [] },
    }, expected),
    /scope differs/i,
  );
  assert.throws(
    () => validateManifestShape({ ...manifest, scope: { ...manifest.scope, protectedRoots: [] } }, expected),
    /scope differs/i,
  );
  assert.throws(
    () => validateManifestShape({
      ...manifest,
      licenseArtifacts: manifest.licenseArtifacts.map((artifact, index) => index === 0 ? { ...artifact, sha256: "bad" } : artifact),
    }, expected),
    /invalid license artifact/i,
  );
});

test("manifest validation rejects duplicate, traversal and symlink-mode entries", () => {
  const { expected, manifest } = validManifestFixture();
  const duplicate = { ...manifest, fileCount: 2, files: [manifest.files[0], manifest.files[0]] };
  assert.throws(() => validateManifestShape(duplicate, expected), /duplicate manifest path/i);

  const traversal = {
    ...manifest,
    files: [{ ...manifest.files[0], path: "legacy/../outside.ts" }],
  };
  assert.throws(() => validateManifestShape(traversal, expected), /invalid manifest file entry path/i);

  const symlinkMode = {
    ...manifest,
    files: [{ ...manifest.files[0], mode: "120000" }],
  };
  assert.throws(() => validateManifestShape(symlinkMode, expected), /invalid manifest mode\/type/i);
});

test("worktree verifier hashes regular files and records executable mode", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eqoboard-legacy-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "legacy"));
  const filePath = path.join(root, "legacy", "a.ts");
  writeFileSync(filePath, "abc");

  const regular = inspectWorktreeFile(root, "legacy/a.ts");
  assert.equal(regular.gitBlobOid, gitBlobSha1(Buffer.from("abc")));
  assert.equal(regular.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(regular.mode, "100644");
  chmodSync(filePath, 0o755);
  assert.equal(inspectWorktreeFile(root, "legacy/a.ts").mode, "100755");
});

test("worktree verifier rejects symlink leaves and symlink parent directories", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eqoboard-legacy-integrity-link-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "eqoboard-legacy-integrity-outside-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(root, "legacy"));
  writeFileSync(path.join(outside, "target.ts"), "abc");
  symlinkSync(path.join(outside, "target.ts"), path.join(root, "legacy", "link.ts"));
  symlinkSync(outside, path.join(root, "legacy", "linkdir"));
  assert.throws(() => inspectWorktreeFile(root, "legacy/link.ts"), /symlink is forbidden/i);
  assert.throws(() => inspectWorktreeFile(root, "legacy/linkdir/target.ts"), /symlink is forbidden/i);
});

test("manifest reader bounds input and rejects symlink and non-regular paths", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eqoboard-manifest-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const regularPath = path.join(root, "manifest.json");
  const directoryPath = path.join(root, "directory");
  const symlinkPath = path.join(root, "manifest-link.json");
  writeFileSync(regularPath, "{}\n");
  mkdirSync(directoryPath);
  symlinkSync(regularPath, symlinkPath);

  assert.deepEqual(readBoundedManifestFile(regularPath, 3), Buffer.from("{}\n"));
  assert.throws(() => readBoundedManifestFile(regularPath, 2), /manifest exceeds size bound/i);
  assert.throws(() => readBoundedManifestFile(directoryPath, 8), /manifest must be a regular file/i);
  assert.throws(() => readBoundedManifestFile(symlinkPath, 8), /manifest must not be a symlink/i);
});
