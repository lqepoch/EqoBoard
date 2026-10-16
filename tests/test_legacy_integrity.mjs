import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASELINE_COMMIT,
  BASELINE_TREE,
  AUTHORIZED_LEGACY_ARCHIVE_PATH,
  AUTHORIZED_LEGACY_TEST_PATH,
  EXCLUDED_PATHS,
  LEGACY_AUTHORIZATION_ID,
  LEGACY_AUTHORIZATION_RECORD_PATH,
  MERGED_MAIN,
  MUTABLE_SHARED_PATHS,
  PREMERGE_MAIN_PREFLIGHT,
  PROTECTED_FILES,
  SOURCE_TAG,
  compareEntrySets,
  compareIndex,
  gitBlobSha1,
  inspectWorktreeFile,
  isSafeRelativePath,
  parseLsFilesStage,
  parseLsTree,
  readBoundedManifestFile,
  validateLegacyAuthorizationBytes,
  validateLegacyAuthorizationRecord,
  validateManifestShape,
  verifyLegacyAuthorizationArtifacts,
} from "../tools/migration/legacy-integrity.mjs";

const HASH = "f".repeat(64);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORIZATION_BYTES = readFileSync(path.join(REPO_ROOT, LEGACY_AUTHORIZATION_RECORD_PATH));
const PRESERVED_ORIGINAL_BYTES = readFileSync(path.join(REPO_ROOT, AUTHORIZED_LEGACY_ARCHIVE_PATH));
const AUTHORIZED_BASELINE_ENTRY = {
  path: AUTHORIZED_LEGACY_TEST_PATH,
  mode: "100644",
  type: "blob",
  gitBlobOid: "e58e7fc364c07a1ddbd49f514e96d7e3aeb3a2be",
  bytes: 41820,
  sha256: "593edeb81e7c8b3fce43d5d211595c982e84d47f7bc681254400a87eeef4220b",
};

function makeAuthorizationRepoFixture(t, { extraTracked = false, extraUntracked = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "eqoboard-legacy-authorization-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recordPath = path.join(root, LEGACY_AUTHORIZATION_RECORD_PATH);
  const archivePath = path.join(root, AUTHORIZED_LEGACY_ARCHIVE_PATH);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(recordPath, AUTHORIZATION_BYTES, { mode: 0o644 });
  writeFileSync(archivePath, PRESERVED_ORIGINAL_BYTES, { mode: 0o644 });
  const stagedPaths = [LEGACY_AUTHORIZATION_RECORD_PATH, AUTHORIZED_LEGACY_ARCHIVE_PATH];
  if (extraTracked || extraUntracked) {
    const extraPath = path.join(path.dirname(recordPath), "second-record.json");
    writeFileSync(extraPath, "{}\n", { mode: 0o644 });
    if (extraTracked) stagedPaths.push(path.relative(root, extraPath).replaceAll(path.sep, "/"));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "--", ...stagedPaths], { cwd: root, stdio: "ignore" });
  return root;
}

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

test("single-file legacy authorization is pinned to the exact audit record and manifest baseline", () => {
  const manifestFiles = [AUTHORIZED_BASELINE_ENTRY];
  const authorization = validateLegacyAuthorizationBytes(AUTHORIZATION_BYTES, manifestFiles);
  assert.equal(authorization.authorizationId, LEGACY_AUTHORIZATION_ID);
  assert.equal(authorization.current.path, AUTHORIZED_LEGACY_TEST_PATH);
  assert.equal(authorization.current.gitBlobOid, "61249affb972b617584c273afa16c9cdbbd8544f");

  const record = JSON.parse(AUTHORIZATION_BYTES.toString("utf8"));
  assert.throws(
    () => validateLegacyAuthorizationRecord({ ...record, authorizationId: "PR65-OTHER" }, manifestFiles),
    /differs from the pinned authorization/i,
  );
  assert.throws(
    () => validateLegacyAuthorizationRecord({ ...record, secondPath: AUTHORIZED_LEGACY_TEST_PATH }, manifestFiles),
    /fields differ/i,
  );
  assert.throws(
    () => validateLegacyAuthorizationRecord({
      ...record,
      preserved: { ...record.preserved, path: "references/legacy/*" },
    }, manifestFiles),
    /differs from the pinned authorization/i,
  );
  assert.throws(
    () => validateLegacyAuthorizationRecord(record, [{ ...AUTHORIZED_BASELINE_ENTRY, gitBlobOid: "0".repeat(40) }]),
    /manifest authorized legacy baseline/i,
  );
  const changedBytes = Buffer.from(AUTHORIZATION_BYTES);
  changedBytes[changedBytes.length - 2] ^= 1;
  assert.throws(() => validateLegacyAuthorizationBytes(changedBytes, manifestFiles), /bytes differ/i);
});

test("index override accepts only the pinned current blob and leaves every other legacy path frozen", () => {
  const authorization = validateLegacyAuthorizationBytes(AUTHORIZATION_BYTES, [AUTHORIZED_BASELINE_ENTRY]);
  const other = {
    path: "apps/openterminal/web/src/untouched.ts",
    mode: "100644",
    type: "blob",
    gitBlobOid: "a".repeat(40),
    bytes: 4,
    sha256: HASH,
  };
  const manifestFiles = [AUTHORIZED_BASELINE_ENTRY, other];
  const exactIndex = [
    { path: AUTHORIZED_LEGACY_TEST_PATH, mode: "100644", gitBlobOid: authorization.current.gitBlobOid, stage: 0 },
    { path: other.path, mode: other.mode, gitBlobOid: other.gitBlobOid, stage: 0 },
  ];
  assert.deepEqual(compareIndex(manifestFiles, exactIndex, authorization), []);
  assert.ok(compareIndex(manifestFiles, [
    { ...exactIndex[0], gitBlobOid: "0".repeat(40) }, exactIndex[1],
  ], authorization).some((message) => /modified protected path/.test(message)));
  assert.ok(compareIndex(manifestFiles, [exactIndex[0]], authorization)
    .some((message) => /deleted protected path/.test(message)));
  assert.ok(compareIndex(manifestFiles, [exactIndex[0], { ...exactIndex[1], gitBlobOid: "b".repeat(40) }], authorization)
    .some((message) => /modified protected path/.test(message)));
  assert.ok(compareIndex(manifestFiles, [...exactIndex, {
    path: "apps/openterminal/web/extra.ts", mode: "100644", gitBlobOid: "c".repeat(40), stage: 0,
  }], authorization).some((message) => /added protected path/.test(message)));
  const forgedAuthorization = { ...authorization, current: { ...authorization.current, gitBlobOid: "d".repeat(40) } };
  assert.ok(compareIndex(manifestFiles, exactIndex, forgedAuthorization)
    .some((message) => /override is not the pinned/i.test(message)));
});

test("authorization record and preserved original must be tracked as the only exact artifact files", (t) => {
  const root = makeAuthorizationRepoFixture(t);
  const valid = verifyLegacyAuthorizationArtifacts(root, [AUTHORIZED_BASELINE_ENTRY]);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.authorization.authorizationId, LEGACY_AUTHORIZATION_ID);

  const extraTrackedRoot = makeAuthorizationRepoFixture(t, { extraTracked: true });
  const extraTracked = verifyLegacyAuthorizationArtifacts(extraTrackedRoot, [AUTHORIZED_BASELINE_ENTRY]);
  assert.equal(extraTracked.authorization, null);
  assert.ok(extraTracked.errors.some((message) => /track exactly its one pinned file/i.test(message)));

  const extraUntrackedRoot = makeAuthorizationRepoFixture(t, { extraUntracked: true });
  const extraUntracked = verifyLegacyAuthorizationArtifacts(extraUntrackedRoot, [AUTHORIZED_BASELINE_ENTRY]);
  assert.equal(extraUntracked.authorization, null);
  assert.ok(extraUntracked.errors.some((message) => /untracked or ignored files/i.test(message)));

  const tamperedArchiveRoot = makeAuthorizationRepoFixture(t);
  writeFileSync(path.join(tamperedArchiveRoot, AUTHORIZED_LEGACY_ARCHIVE_PATH), Buffer.concat([
    PRESERVED_ORIGINAL_BYTES,
    Buffer.from("tampered"),
  ]));
  const tamperedArchive = verifyLegacyAuthorizationArtifacts(tamperedArchiveRoot, [AUTHORIZED_BASELINE_ENTRY]);
  assert.equal(tamperedArchive.authorization, null);
  assert.ok(tamperedArchive.errors.some((message) => /preserved legacy original .* differs from the pinned identity/i.test(message)));
});

test("authorization and archive worktree reads reject symlink replacement even when their index is unchanged", (t) => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "eqoboard-legacy-authorization-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, "target.bin");
  writeFileSync(outsideFile, PRESERVED_ORIGINAL_BYTES);

  for (const artifactPath of [LEGACY_AUTHORIZATION_RECORD_PATH, AUTHORIZED_LEGACY_ARCHIVE_PATH]) {
    const root = makeAuthorizationRepoFixture(t);
    const replacement = path.join(root, artifactPath);
    rmSync(replacement);
    symlinkSync(outsideFile, replacement);
    const result = verifyLegacyAuthorizationArtifacts(root, [AUTHORIZED_BASELINE_ENTRY]);
    assert.equal(result.authorization, null);
    assert.ok(result.errors.some((message) => /symlink is forbidden/i.test(message)));
  }
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
  assert.throws(() => validateManifestShape(duplicate, expected), /duplicate manifest file path/i);

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
