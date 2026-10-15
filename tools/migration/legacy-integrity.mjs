#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_COMMIT = "fea1e952add7a11e799d6f9f198ddcee47fd12b6";
export const BASELINE_TREE = "986dd808560016965e73edc1869603b621b4286e";
export const SOURCE_TAG = Object.freeze({
  tag: "migration/eqoboard-native-source-20261015-fea1e95",
  tagObject: "9d606d11fa95ffa696aa009b52695d2c349f6a97",
  commit: BASELINE_COMMIT,
});
export const MERGED_MAIN = Object.freeze({
  commit: "e5f0f6b7531eb73356eb4059d5cef9e37584b259",
  tree: BASELINE_TREE,
});
export const PREMERGE_MAIN_PREFLIGHT = Object.freeze({
  tag: "migration/eqoboard-native-20261015-740765ec",
  tagObject: "636253df34f3d7d458e4236564db5be153628ad5",
  commit: "740765ec824988eda24822b943c5604f8d565ebf",
});
export const MANIFEST_RELATIVE_PATH = "references/legacy/manifest-fea1e952.json";
export const PROTECTED_ROOTS = Object.freeze([
  "apps/gateway/openbb",
  "apps/openterminal",
  "third_party/licenses/openbb-workspace",
  "tools/openbb",
]);
export const PROTECTED_FILES = Object.freeze([
  ".agents/skills/openbb-workspace/SKILL.md", "LICENSE",
  "apps/gateway/src/openbb.rs", "apps/gateway/src/openbb_tests.rs",
  "compose.openbb.e2e.yaml", "compose.openbb.release.yaml", "compose.openbb.yaml",
  "docs/OPENBB_SUPPLY_CHAIN.md", "docs/THIRD_PARTY.md", "docs/UPSTREAM_AUDIT.md",
  "docs/evidence/openbb-local-runtime-acceptance.json",
  "tests/test_openbb_community.py", "tests/test_openbb_docker_save_oci.py",
  "tests/test_openbb_supply_chain.py", "tests/test_openbb_upstream_diff.py",
  "third_party/upstreams.lock.json",
  "tools/openbb-lite-e2e.sh", "tools/openbb-sanitize-e2e-logs.mjs",
]);
export const MUTABLE_SHARED_PATHS = Object.freeze([
  ".github/workflows/openbb.yml", "tests/fixtures/auto_merge/openbb-optional-check-runs.json",
  "tools/ci/openbb-ci-gate.mjs", "tools/ci/openbb-ci-gate.test.mjs",
  "tools/ci/openbb-ci-route.mjs", "tools/ci/openbb-ci-route.test.mjs",
]);
export const EXCLUDED_PATHS = Object.freeze([
  ".github/workflows/openbb.yml",
  "apps/eqoboard-web",
  "docs/migration/FEATURE_INVENTORY.md", "references/README.md", "references/legacy",
  "tests/fixtures/auto_merge/openbb-optional-check-runs.json",
  "tests/test_legacy_integrity.mjs", "tests/test_native_build_boundary.py",
  "tools/ci/openbb-ci-gate.mjs", "tools/ci/openbb-ci-gate.test.mjs",
  "tools/ci/openbb-ci-route.mjs", "tools/ci/openbb-ci-route.test.mjs",
  "tools/migration/legacy-integrity.mjs", "tools/native-web-compose-e2e.sh", "tools/native-web-sbom.sh",
]);

const EXPECTED = Object.freeze({
  commit: BASELINE_COMMIT,
  tree: BASELINE_TREE,
  sourceTag: SOURCE_TAG,
  mergedMain: MERGED_MAIN,
  premergeMain: PREMERGE_MAIN_PREFLIGHT,
  roots: PROTECTED_ROOTS,
  files: PROTECTED_FILES,
  excluded: EXCLUDED_PATHS,
  mutableShared: MUTABLE_SHARED_PATHS,
});
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BLOB_BYTES = 24 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_COUNT = 5000;
const GIT_TIMEOUT_MS = 30000;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MODE_RE = /^(100644|100755)$/;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function comparePath(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(label + " is not valid UTF-8");
  }
}

export function readBoundedManifestFile(filePath, maxBytes = MAX_MANIFEST_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_MANIFEST_BYTES) {
    fail("Invalid manifest size bound");
  }

  const beforeOpen = lstatSync(filePath, { bigint: true });
  if (beforeOpen.isSymbolicLink()) fail("Manifest must not be a symlink");
  if (!beforeOpen.isFile()) fail("Manifest must be a regular file");
  if (beforeOpen.size > BigInt(maxBytes)) fail("Manifest exceeds size bound");

  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    fail("Manifest reader requires O_NOFOLLOW support");
  }

  let descriptor;
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) fail("Manifest must be a regular file");
    if (opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino) {
      fail("Manifest changed while opening");
    }
    if (opened.size > BigInt(maxBytes)) fail("Manifest exceeds size bound");

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxBytes) fail("Manifest exceeds size bound");

    const afterRead = fstatSync(descriptor, { bigint: true });
    if (
      !afterRead.isFile()
      || afterRead.dev !== opened.dev
      || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size
      || afterRead.mtimeNs !== opened.mtimeNs
      || afterRead.ctimeNs !== opened.ctimeNs
      || BigInt(bytesRead) !== opened.size
    ) {
      fail("Manifest changed while reading");
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nulRecords(buffer, label) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      records.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== buffer.length) fail(label + " output is not NUL terminated");
  return records.filter((record) => record.length > 0);
}

export function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.startsWith("/") || value.includes("\\") || value.startsWith(":")) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function gitBlobSha1(bytes) {
  const header = Buffer.from("blob " + bytes.length + "\0", "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseLsTree(output) {
  if (!Buffer.isBuffer(output)) fail("git ls-tree output must be a Buffer");
  const entries = [];
  for (const record of nulRecords(output, "git ls-tree")) {
    const separator = record.indexOf(9);
    if (separator < 0) fail("Malformed git ls-tree record");
    const header = decodeUtf8(record.subarray(0, separator), "git ls-tree header").trim();
    const fields = header.split(/\s+/u);
    if (fields.length !== 4) fail("Malformed git ls-tree header");
    const [mode, type, oid, sizeText] = fields;
    const filePath = decodeUtf8(record.subarray(separator + 1), "git tree path");
    const bytes = Number(sizeText);
    if (!isSafeRelativePath(filePath)) fail("Unsafe path in Git tree");
    if (type !== "blob" || !MODE_RE.test(mode)) fail("Unsupported protected Git object type or mode: " + filePath);
    if (!SHA1_RE.test(oid)) fail("Invalid Git blob OID in tree: " + filePath);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SINGLE_FILE_BYTES) fail("Protected file size is outside the verifier bound: " + filePath);
    entries.push({ path: filePath, mode, type, gitBlobOid: oid, bytes });
  }
  return entries;
}

export function parseLsFilesStage(output) {
  if (!Buffer.isBuffer(output)) fail("git ls-files output must be a Buffer");
  const entries = [];
  for (const record of nulRecords(output, "git ls-files --stage")) {
    const separator = record.indexOf(9);
    if (separator < 0) fail("Malformed git ls-files --stage record");
    const header = decodeUtf8(record.subarray(0, separator), "git index header").trim();
    const fields = header.split(/\s+/u);
    if (fields.length !== 3) fail("Malformed git index header");
    const [mode, oid, stageText] = fields;
    const filePath = decodeUtf8(record.subarray(separator + 1), "git index path");
    const stage = Number(stageText);
    if (!isSafeRelativePath(filePath)) fail("Unsafe path in Git index");
    if (!MODE_RE.test(mode) || !SHA1_RE.test(oid) || stage !== 0) fail("Unmerged or unsupported protected index entry: " + filePath);
    entries.push({ path: filePath, mode, gitBlobOid: oid, stage });
  }
  return entries;
}

export function compareEntrySets(expectedEntries, actualEntries, compareContent = true) {
  const errors = [];
  const expectedByPath = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actualEntries.map((entry) => [entry.path, entry]));
  if (expectedByPath.size !== expectedEntries.length) errors.push("manifest contains duplicate paths");
  if (actualByPath.size !== actualEntries.length) errors.push("tree/index contains duplicate paths");
  for (const [filePath, expected] of expectedByPath) {
    const actual = actualByPath.get(filePath);
    if (!actual) { errors.push("missing protected path: " + filePath); continue; }
    for (const key of ["mode", "type", "gitBlobOid", "bytes"]) {
      if (expected[key] !== actual[key]) errors.push("baseline " + key + " mismatch: " + filePath);
    }
    if (compareContent && expected.sha256 !== actual.sha256) errors.push("baseline sha256 mismatch: " + filePath);
    if (actual.featureIds && JSON.stringify(expected.featureIds) !== JSON.stringify(actual.featureIds)) errors.push("baseline feature attribution mismatch: " + filePath);
    if (actual.provenanceRef && expected.provenanceRef !== actual.provenanceRef) errors.push("baseline provenance reference mismatch: " + filePath);
  }
  for (const filePath of actualByPath.keys()) {
    if (!expectedByPath.has(filePath)) errors.push("unexpected protected path: " + filePath);
  }
  return errors;
}

export function validateManifestShape(manifest, expected = EXPECTED) {
  if (!isRecord(manifest)) fail("Manifest must be a JSON object");
  if (manifest.schemaVersion !== 2 || manifest.kind !== "eqoboard-legacy-integrity-baseline") fail("Unsupported manifest kind or schema version");
  if (!isRecord(manifest.baseline) || !isRecord(manifest.scope)) fail("Missing baseline or scope");
  if (manifest.baseline.commit !== expected.commit || manifest.baseline.tree !== expected.tree) fail("Manifest baseline is not the frozen source snapshot");
  if (manifest.baseline.objectFormat !== "sha1") fail("Unsupported Git object format");
  if (manifest.baseline.acceptance !== "source-tagged-tree-merged-to-main-not-native-parity-or-release-acceptance") fail("Manifest incorrectly labels source merge or native release acceptance");
  const sourceTag = manifest.baseline.sourceTag;
  if (!isRecord(sourceTag)
      || ["tag", "tagObject", "commit"].some((key) => sourceTag[key] !== expected.sourceTag[key])
      || sourceTag.commit !== manifest.baseline.commit) fail("Frozen source tag reference differs from the pinned source commit");
  const mergedMain = manifest.baseline.mergedMain;
  if (!isRecord(mergedMain)
      || ["commit", "tree"].some((key) => mergedMain[key] !== expected.mergedMain[key])
      || mergedMain.tree !== manifest.baseline.tree) fail("Recorded merge commit/tree differs from the frozen source snapshot");
  const premergeMain = manifest.baseline.premergeMainPreflight;
  if (!isRecord(premergeMain)
      || ["tag", "tagObject", "commit"].some((key) => premergeMain[key] !== expected.premergeMain[key])) fail("Historical main preflight tag reference differs from the recorded prerequisite");
  if (JSON.stringify(manifest.scope.protectedRoots) !== JSON.stringify(expected.roots)
      || JSON.stringify(manifest.scope.protectedFiles) !== JSON.stringify(expected.files)
      || JSON.stringify(manifest.scope.excludedPaths) !== JSON.stringify(expected.excluded)
      || JSON.stringify(manifest.scope.mutableSharedPaths) !== JSON.stringify(expected.mutableShared)) fail("Manifest protected/excluded path scope differs from the frozen allowlist");
  if (manifest.scope.coverage !== "all tracked files under protectedRoots plus protectedFiles at the pinned source commit") fail("Manifest does not claim complete baseline path coverage");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILE_COUNT) fail("Manifest file list is absent or outside the verifier bound");
  if (manifest.fileCount !== manifest.files.length) fail("Manifest fileCount does not match files");
  const seen = new Set();
  let priorPath = "";
  for (const entry of manifest.files) {
    if (!isRecord(entry) || !isSafeRelativePath(entry.path)) fail("Invalid manifest file entry path");
    if (!isInScope(entry.path, expected.roots, expected.files)) fail("Manifest entry is outside protected scope");
    if (seen.has(entry.path)) fail("Duplicate manifest file path: " + entry.path);
    if (priorPath && entry.path <= priorPath) fail("Manifest file entries are not strictly path-sorted");
    priorPath = entry.path;
    seen.add(entry.path);
    if (!MODE_RE.test(entry.mode) || entry.type !== "blob") fail("Invalid manifest mode/type: " + entry.path);
    if (!SHA1_RE.test(entry.gitBlobOid) || !SHA256_RE.test(entry.sha256)) fail("Invalid manifest hash: " + entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_SINGLE_FILE_BYTES) fail("Invalid manifest byte count: " + entry.path);
    if (!Array.isArray(entry.featureIds) || entry.featureIds.length === 0
        || entry.featureIds.some((value) => typeof value !== "string" || value.length > 96)) fail("Invalid manifest feature attribution: " + entry.path);
    if (typeof entry.provenanceRef !== "string" || entry.provenanceRef.length === 0) fail("Missing provenance reference: " + entry.path);
  }
  if (!isRecord(manifest.provenance) || !Array.isArray(manifest.licenseArtifacts)
      || manifest.licenseArtifacts.length < 4) fail("Manifest must bind the legacy and OpenBB license notices");
  const artifactPaths = new Set();
  for (const artifact of manifest.licenseArtifacts) {
    if (!isRecord(artifact) || !isSafeRelativePath(artifact.path)
        || !["MIT", "Apache-2.0", "NOTICE"].includes(artifact.license)
        || !SHA256_RE.test(artifact.sha256) || typeof artifact.provenanceRef !== "string"
        || !artifact.provenanceRef || !(artifact.lockedSha256 === null || SHA256_RE.test(artifact.lockedSha256))) fail("Invalid license artifact record");
    if (artifactPaths.has(artifact.path)) fail("Duplicate license artifact path: " + artifact.path);
    artifactPaths.add(artifact.path);
  }
  return true;
}

function isInScope(filePath, roots, exactFiles) {
  if (exactFiles.includes(filePath)) return true;
  return roots.some((root) => filePath === root || filePath.startsWith(root + "/"));
}

function runGit(repoRoot, args, options = {}) {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    env,
    encoding: null,
    input: options.input,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer || MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error) fail("Git command failed: " + result.error.message);
  if (result.status !== 0) {
    const detail = decodeUtf8(result.stderr || Buffer.alloc(0), "Git stderr").trim().slice(0, 1200);
    fail("Git command failed (" + args[0] + "): " + detail);
  }
  return result.stdout || Buffer.alloc(0);
}

function runGitText(repoRoot, args) { return decodeUtf8(runGit(repoRoot, args), "Git output").trim(); }

function scopeArgs() { return ["--", ...PROTECTED_ROOTS, ...PROTECTED_FILES]; }

function readBlobBatch(repoRoot, entries) {
  const input = Buffer.from(entries.map((entry) => entry.gitBlobOid).join("\n") + "\n", "ascii");
  const maxOutput = Math.min(
    MAX_GIT_OUTPUT_BYTES,
    MAX_TOTAL_BLOB_BYTES + entries.length * 128 + 1024,
  );
  const output = runGit(repoRoot, ["cat-file", "--batch"], { input, maxBuffer: maxOutput });
  const blobs = new Map();
  let offset = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) fail("Truncated git cat-file batch header");
    const header = decodeUtf8(output.subarray(offset, headerEnd), "git cat-file header");
    const match = /^([0-9a-f]{40}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== entry.gitBlobOid) fail("Unexpected object in git cat-file batch");
    const byteCount = Number(match[2]);
    if (!Number.isSafeInteger(byteCount) || byteCount !== entry.bytes || byteCount > MAX_SINGLE_FILE_BYTES) fail("Git blob size differs from protected tree: " + entry.path);
    totalBytes += byteCount;
    if (totalBytes > MAX_TOTAL_BLOB_BYTES) fail("Protected baseline exceeds total byte bound");
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + byteCount;
    if (contentEnd >= output.length || output[contentEnd] !== 10) fail("Truncated git cat-file batch body");
    const content = output.subarray(contentStart, contentEnd);
    if (gitBlobSha1(content) !== entry.gitBlobOid) fail("Git blob OID does not match content: " + entry.path);
    blobs.set(entry.path, content);
    offset = contentEnd + 1;
  }
  if (offset !== output.length) fail("Unexpected trailing data in git cat-file batch");
  return blobs;
}

function sourceByName(lock, name) {
  if (!isRecord(lock) || !Array.isArray(lock.sources)) fail("Malformed upstream lock in frozen baseline");
  const matches = lock.sources.filter((source) => source && source.name === name);
  if (matches.length !== 1) fail("Expected one upstream source entry: " + name);
  return matches[0];
}

function projectProvenance(lock) {
  const terminal = sourceByName(lock, "OpenTerminal");
  const grid = sourceByName(lock, "AG Grid Community");
  const openbb = sourceByName(lock, "OpenBB Workspace");
  if (terminal.commit !== "aed097c680cd8ec1c391ae06966babe7d6d91fc6"
      || terminal.license !== "MIT" || terminal.repository !== "ErTasselli/OpenTerminal") {
    fail("Frozen OpenTerminal source pin differs from the audited provenance");
  }
  if (grid.version !== "36.2.0" || grid.license !== "MIT") fail("AG Grid Community pin differs from audited provenance");
  if (openbb.commit !== "be00e95019a55d57af146919ee46b7e1a4859226"
      || openbb.license !== "Apache-2.0" || openbb.repository !== "OpenBB-finance/workspace") {
    fail("Frozen OpenBB source pin differs from the audited provenance");
  }
  if (!openbb.source_archive || !Array.isArray(openbb.license_files) || !openbb.build_recipe) {
    fail("OpenBB source archive, notices or community recipe are missing from lock");
  }
  return {
    openTerminal: {
      repository: terminal.repository,
      commit: terminal.commit,
      license: terminal.license,
      downstreamPrefix: terminal.downstream_prefix,
      archiveSha256: terminal.git_archive_sha256 || null,
      archiveHashStatus: terminal.git_archive_sha256
        ? "bound-by-upstreams-lock"
        : "not-bound-by-upstreams-lock-at-frozen-baseline",
      licensePath: "apps/openterminal/LICENSE",
    },
    agGridCommunity: {
      package: grid.package,
      version: grid.version,
      license: grid.license,
      downstreamPath: grid.downstream_path,
    },
    openbbWorkspace: {
      repository: openbb.repository,
      commit: openbb.commit,
      license: openbb.license,
      archivedAt: openbb.archived_at,
      downstreamPrefix: openbb.downstream_prefix,
      sourceArchive: {
        format: openbb.source_archive.format,
        url: openbb.source_archive.url,
        sha256: openbb.source_archive.sha256,
      },
      licenseFiles: openbb.license_files.map((item) => ({
        upstreamPath: item.upstream_path,
        localPath: item.local_path,
        sha256: item.sha256,
      })),
      communityRecipe: {
        path: openbb.build_recipe.path,
        sha256: openbb.build_recipe.sha256,
        variant: openbb.build_recipe.variant,
        runner: openbb.build_recipe.source_patch.runner,
        patchFiles: openbb.build_recipe.source_patch.files,
        supportFiles: openbb.build_recipe.support_files,
      },
      knownBuildFindings: openbb.build_gate.baseline_upstream_findings,
    },
  };
}

function featureIdsForPath(filePath) {
  const widgetNames = {
    QuoteWidget: "quote", ChartWidget: "chart", WatchlistWidget: "watchlist",
    NewsWidget: "news", HeatmapWidget: "heatmap", ScreenerWidget: "screener",
    CryptoWidget: "crypto", MacroWidget: "macro", OptionsWidget: "options",
    IvSkewWidget: "iv-skew", OptionTapeWidget: "option-tape", VerticalSpreadWidget: "vertical-spread",
    PortfolioWidget: "portfolio", AiWidget: "ai", CalendarWidget: "calendar",
    InsiderWidget: "insider", TvWidget: "tv", RecapWidget: "recap",
    ResearchPredictionsWidget: "research-predictions",
    EngineOfflinePreviewWidget: "engine-offline-preview",
  };
  const widgetsPrefix = "apps/openterminal/web/components/widgets/";
  if (filePath.startsWith(widgetsPrefix)) {
    const basename = path.posix.basename(filePath, ".tsx");
    if (widgetNames[basename]) return ["legacy-widget:" + widgetNames[basename]];
    if (basename === "MarketFeedStatus") return ["legacy-helper:market-feed-status"];
    if (basename === "OrderOutcomePanel") return ["legacy-helper:order-outcome"];
  }
  const panelsPrefix = "apps/openterminal/web/components/terminal/";
  if (filePath.startsWith(panelsPrefix)) {
    return ["legacy-pro-panel:" + path.posix.basename(filePath, path.posix.extname(filePath)).toLowerCase()];
  }
  if (filePath.startsWith("apps/openterminal/")) return ["legacy-openterminal-app"];
  if (filePath === "apps/gateway/src/openbb.rs" || filePath === "apps/gateway/src/openbb_tests.rs") {
    return ["legacy-openbb-gateway-implementation"];
  }
  if (filePath.startsWith("apps/gateway/openbb/")) return ["legacy-openbb-gateway-integration"];
  if (filePath.startsWith("third_party/licenses/openbb-workspace/")) return ["openbb-license-notice"];
  if (filePath.startsWith("tools/openbb/")) return ["openbb-source-verification-and-community-patch"];
  if (filePath === "tools/openbb-lite-e2e.sh" || filePath === "tools/openbb-sanitize-e2e-logs.mjs") {
    return ["openbb-runtime-test-helper"];
  }
  if (filePath.startsWith("compose.openbb.")) return ["openbb-runtime-compose"];
  if (filePath === "LICENSE") return ["eqoboard-repository-license"];
  if (filePath === ".agents/skills/openbb-workspace/SKILL.md") return ["openbb-workspace-maintenance-skill"];
  if (filePath === "third_party/upstreams.lock.json") return ["third-party-source-lock"];
  if (filePath.startsWith("tests/test_openbb_")) return ["legacy-openbb-tests"];
  if (["docs/OPENBB_SUPPLY_CHAIN.md", "docs/THIRD_PARTY.md", "docs/UPSTREAM_AUDIT.md",
    "docs/evidence/openbb-local-runtime-acceptance.json"].includes(filePath)) {
    return ["openbb-provenance-documentation"];
  }
  return ["legacy-protected-source"];
}

function provenanceRefForPath(filePath) {
  if (filePath.startsWith("apps/openterminal/")) return "open-terminal-legacy";
  if (filePath.startsWith("apps/gateway/src/openbb")) return "openbb-gateway-implementation";
  if (filePath.startsWith("apps/gateway/openbb/")) return "openbb-gateway-integration";
  if (filePath.startsWith("third_party/licenses/openbb-workspace/")) return "openbb-apache-license-and-notice";
  if (filePath.startsWith("tools/openbb/")) return "openbb-community-source-recipe";
  if (filePath.startsWith("tools/openbb-") || filePath.startsWith("compose.openbb.")) return "openbb-runtime-test-harness";
  if (filePath.startsWith("tests/test_openbb_")) return "openbb-source-and-community-tests";
  if (filePath.startsWith("docs/OPENBB_") || filePath === "docs/UPSTREAM_AUDIT.md") return "openbb-provenance-documentation";
  if (filePath === "LICENSE") return "eqoboard-repository-license";
  if (filePath === ".agents/skills/openbb-workspace/SKILL.md") return "openbb-workspace-maintenance-skill";
  return "locked-provenance-and-license-record";
}

function makeLicenseArtifacts(fileMap, provenance) {
  const artifacts = [];
  const repositoryLicense = fileMap.get("LICENSE");
  if (!repositoryLicense) fail("Repository MIT license is not included in protected scope");
  artifacts.push({
    path: "LICENSE",
    license: "MIT",
    provenanceRef: "eqoboard-repository-license",
    lockedSha256: null,
    sha256: repositoryLicense.sha256,
  });
  const terminalLicensePath = provenance.openTerminal.licensePath;
  const terminalLicense = fileMap.get(terminalLicensePath);
  if (!terminalLicense) fail("OpenTerminal MIT license is not included in protected scope");
  artifacts.push({
    path: terminalLicensePath,
    license: "MIT",
    provenanceRef: "open-terminal-legacy",
    lockedSha256: null,
    sha256: terminalLicense.sha256,
  });
  for (const licenseFile of provenance.openbbWorkspace.licenseFiles) {
    const local = fileMap.get(licenseFile.localPath);
    if (!local) fail("OpenBB license or notice is not included in protected scope: " + licenseFile.localPath);
    if (local.sha256 !== licenseFile.sha256) {
      fail("OpenBB locked license/notice hash differs from frozen bytes: " + licenseFile.localPath);
    }
    artifacts.push({
      path: licenseFile.localPath,
      license: licenseFile.upstreamPath === "NOTICE" ? "NOTICE" : "Apache-2.0",
      provenanceRef: "openbb-apache-license-and-notice",
      lockedSha256: licenseFile.sha256,
      sha256: local.sha256,
    });
  }
  return artifacts.sort((left, right) => comparePath(left.path, right.path));
}

function validateProvenanceArtifacts(manifest, fileMap, provenance) {
  const expectedArtifacts = makeLicenseArtifacts(fileMap, provenance);
  if (JSON.stringify(manifest.licenseArtifacts) !== JSON.stringify(expectedArtifacts)) {
    fail("License/NOTICE artifact hashes or provenance differ from frozen source");
  }
  const recipe = provenance.openbbWorkspace.communityRecipe;
  const recipeFiles = [
    { path: recipe.path, sha256: recipe.sha256 },
    recipe.runner,
    ...recipe.patchFiles,
    ...recipe.supportFiles,
  ];
  for (const artifact of recipeFiles) {
    const file = artifact && fileMap.get(artifact.path);
    if (!file || file.sha256 !== artifact.sha256) {
      fail("OpenBB source recipe hash differs from frozen bytes: " + (artifact?.path || "unknown path"));
    }
  }
  if (JSON.stringify(manifest.provenance) !== JSON.stringify(provenance)) {
    fail("Manifest license/source provenance differs from frozen upstream lock");
  }
}

function resolveExpectedSnapshot(repoRoot, expected = EXPECTED) {
  const commit = runGitText(repoRoot, ["rev-parse", expected.commit + "^{commit}"]);
  const tree = runGitText(repoRoot, ["rev-parse", expected.commit + "^{tree}"]);
  if (commit !== expected.commit || tree !== expected.tree) {
    fail("Frozen baseline Git commit/tree is unavailable or does not match");
  }
}

function getBaselineTree(repoRoot, expected = EXPECTED) {
  const output = runGit(repoRoot, [
    "ls-tree", "-r", "-z", "-l", "--full-tree", expected.commit,
    ...scopeArgs(),
  ]);
  const entries = parseLsTree(output).sort((left, right) => comparePath(left.path, right.path));
  if (entries.length === 0 || entries.length > MAX_FILE_COUNT) fail("Protected Git tree path count is invalid");
  return entries;
}

function buildFileEntries(repoRoot, treeEntries) {
  const blobs = readBlobBatch(repoRoot, treeEntries);
  return treeEntries.map((entry) => {
    const content = blobs.get(entry.path);
    if (!content) fail("Missing Git blob content: " + entry.path);
    return {
      ...entry,
      sha256: sha256(content),
      featureIds: featureIdsForPath(entry.path),
      provenanceRef: provenanceRefForPath(entry.path),
    };
  });
}

function makeManifest(repoRoot, expected = EXPECTED) {
  resolveExpectedSnapshot(repoRoot, expected);
  const treeEntries = getBaselineTree(repoRoot, expected);
  const files = buildFileEntries(repoRoot, treeEntries);
  const fileMap = new Map(files.map((entry) => [entry.path, entry]));
  const lockEntry = fileMap.get("third_party/upstreams.lock.json");
  if (!lockEntry) fail("Upstream source lock is outside protected scope");
  const lockContent = readBlobBatch(repoRoot, [lockEntry]).get(lockEntry.path);
  const lock = JSON.parse(decodeUtf8(lockContent, "upstreams.lock.json"));
  const provenance = projectProvenance(lock);
  const licenseArtifacts = makeLicenseArtifacts(fileMap, provenance);
  validateProvenanceArtifacts({ licenseArtifacts, provenance }, fileMap, provenance);
  return {
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
      protectedRoots: [...expected.roots],
      protectedFiles: [...expected.files],
      excludedPaths: [...expected.excluded],
      mutableSharedPaths: [...expected.mutableShared],
      coverage: "all tracked files under protectedRoots plus protectedFiles at the pinned source commit",
    },
    fileCount: files.length,
    provenance,
    licenseArtifacts,
    files,
  };
}

function compareIndex(manifestFiles, indexEntries) {
  const expectedEntries = manifestFiles.map(({ path: filePath, mode, gitBlobOid }) => ({
    path: filePath,
    mode,
    gitBlobOid,
    stage: 0,
  }));
  const errors = [];
  const expected = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const actual = new Map(indexEntries.map((entry) => [entry.path, entry]));
  if (actual.size !== indexEntries.length) errors.push("Git index contains duplicate protected paths");
  for (const entry of expectedEntries) {
    const found = actual.get(entry.path);
    if (!found) errors.push("Git index deleted protected path: " + entry.path);
    else if (found.mode !== entry.mode || found.gitBlobOid !== entry.gitBlobOid || found.stage !== 0) {
      errors.push("Git index modified protected path: " + entry.path);
    }
  }
  for (const entry of actual.values()) {
    if (!expected.has(entry.path)) errors.push("Git index added protected path: " + entry.path);
  }
  return errors;
}

export function inspectWorktreeFile(repoRoot, filePath) {
  if (!isSafeRelativePath(filePath)) fail("Unsafe worktree path");
  const root = realpathSync(repoRoot);
  const parts = filePath.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail("Symlink is forbidden in protected path: " + filePath);
    const final = index === parts.length - 1;
    if (!final && !stat.isDirectory()) fail("Protected parent is not a directory: " + filePath);
    if (final && !stat.isFile()) fail("Protected path is not a regular file: " + filePath);
  }
  const resolved = realpathSync(current);
  if (!resolved.startsWith(root + path.sep)) fail("Protected file resolves outside repository");
  const stat = lstatSync(current);
  const mode = stat.mode & 0o111 ? "100755" : "100644";
  const content = readFileSync(current);
  if (content.length > MAX_SINGLE_FILE_BYTES) fail("Worktree file exceeds size bound: " + filePath);
  return {
    path: filePath,
    mode,
    type: "blob",
    gitBlobOid: gitBlobSha1(content),
    bytes: content.length,
    sha256: sha256(content),
  };
}

export function verifyManifestAtRepo(repoRoot, manifest, expected = EXPECTED) {
  validateManifestShape(manifest, expected);
  resolveExpectedSnapshot(repoRoot, expected);
  const treeEntries = getBaselineTree(repoRoot, expected);
  const baselineErrors = compareEntrySets(manifest.files, treeEntries, false);
  const errors = [...baselineErrors];
  if (errors.length) return { errors, checkedFiles: 0 };

  const baselineFiles = buildFileEntries(repoRoot, treeEntries);
  errors.push(...compareEntrySets(manifest.files, baselineFiles, true));
  const baselineMap = new Map(baselineFiles.map((entry) => [entry.path, entry]));
  const lockEntry = baselineMap.get("third_party/upstreams.lock.json");
  const lockBytes = readBlobBatch(repoRoot, [lockEntry]).get(lockEntry.path);
  const provenance = projectProvenance(JSON.parse(decodeUtf8(lockBytes, "upstreams.lock.json")));
  try {
    validateProvenanceArtifacts(manifest, baselineMap, provenance);
  } catch (error) {
    errors.push(error.message);
  }

  const indexEntries = parseLsFilesStage(runGit(repoRoot, ["ls-files", "--stage", "-z", ...scopeArgs()]));
  errors.push(...compareIndex(manifest.files, indexEntries));
  const untracked = nulRecords(
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...scopeArgs()]),
    "git ls-files --others",
  );
  if (untracked.length) errors.push("Untracked files exist inside protected legacy scope: " + untracked.length);

  let checkedFiles = 0;
  for (const expectedFile of manifest.files) {
    try {
      const actual = inspectWorktreeFile(repoRoot, expectedFile.path);
      checkedFiles += 1;
      for (const key of ["mode", "type", "gitBlobOid", "bytes", "sha256"]) {
        if (actual[key] !== expectedFile[key]) {
          errors.push("Worktree " + key + " mismatch: " + expectedFile.path);
        }
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { errors, checkedFiles };
}

function parseArgs(args) {
  const options = { repo: ROOT_DIR, manifest: null, createManifest: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--create-manifest") {
      options.createManifest = true;
    } else if (arg === "--repo" || arg === "--manifest") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) fail("Missing value for " + arg);
      options[arg === "--repo" ? "repo" : "manifest"] = value;
      index += 1;
    } else {
      fail("Unknown argument: " + arg);
    }
  }
  if (options.createManifest && options.manifest) fail("--manifest cannot be combined with --create-manifest");
  return options;
}

function usage() {
  return [
    "Read-only legacy integrity verifier for the frozen EqoBoard source snapshot.",
    "Usage: node tools/migration/legacy-integrity.mjs [--repo PATH] [--manifest PATH]",
    "       node tools/migration/legacy-integrity.mjs [--repo PATH] --create-manifest",
    "Manifest creation is write-once and always targets " + MANIFEST_RELATIVE_PATH + ".",
    "Verification never modifies files and never enables deletion of protected legacy paths.",
  ].join("\n");
}

function createManifestFile(repoRoot) {
  const manifestPath = path.join(repoRoot, MANIFEST_RELATIVE_PATH);
  if (existsSync(manifestPath)) fail("Refusing to overwrite existing manifest: " + MANIFEST_RELATIVE_PATH);
  const manifest = makeManifest(repoRoot);
  validateManifestShape(manifest);
  const json = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(json, "utf8") > MAX_MANIFEST_BYTES) fail("Generated manifest exceeds size bound");
  ensureSafeDirectoryTree(repoRoot, path.posix.dirname(MANIFEST_RELATIVE_PATH));
  const descriptor = openSync(manifestPath, "wx", 0o644);
  try {
    writeFileSync(descriptor, json, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return manifest;
}

function ensureSafeDirectoryTree(repoRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) fail("Unsafe output directory path");
  const root = realpathSync(repoRoot);
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail("Manifest output parent must be a real directory");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o755 });
    }
    if (!realpathSync(current).startsWith(root + path.sep)) {
      fail("Manifest output directory resolves outside repository");
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const repoRoot = realpathSync(options.repo);
  const gitRoot = runGitText(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(gitRoot) !== repoRoot) fail("--repo must be the Git repository root");
  if (options.createManifest) {
    const manifest = createManifestFile(repoRoot);
    process.stdout.write(
      "Created source-tagged manifest for " + manifest.fileCount + " protected files at "
      + manifest.baseline.commit + ". Merge metadata does not prove native parity or release acceptance.\n",
    );
    return;
  }
  const manifestPath = options.manifest
    ? path.resolve(repoRoot, options.manifest)
    : path.join(repoRoot, MANIFEST_RELATIVE_PATH);
  const manifestBytes = readBoundedManifestFile(manifestPath);
  const manifest = JSON.parse(decodeUtf8(manifestBytes, "manifest"));
  const result = verifyManifestAtRepo(repoRoot, manifest);
  if (result.errors.length) {
    process.stderr.write("FAIL legacy integrity: " + result.errors.join("; ") + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "PASS legacy integrity: " + result.checkedFiles + " protected files match frozen source "
    + manifest.baseline.commit + ". This does not prove feature parity or release acceptance.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write("FAIL legacy integrity: " + error.message + "\n");
    process.exitCode = 1;
  }
}
