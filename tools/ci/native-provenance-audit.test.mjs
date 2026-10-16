import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateNativeSourceProvenance } from "./native-provenance-audit.mjs";

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-provenance-audit-"));
  try {
    mkdirSync(path.join(root, "apps/eqoboard-web/app"), { recursive: true });
    writeFileSync(path.join(root, "apps/eqoboard-web/app/page.tsx"), "export default function Page() {}\n");
    writeFileSync(path.join(root, "apps/eqoboard-web/next.config.mjs"), "export default {};\n");
    run(root, fixtureDocument());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixtureDocument() {
  return {
    records: [
      {
        agent: "native_app",
        source_provenance: { classification: "first-party independent implementation" },
        files: ["apps/eqoboard-web/app/page.tsx"],
      },
    ],
    rootIntegration: {
      agent: "native_root_integration",
      source_provenance: { classification: "first-party configuration" },
      files: ["apps/eqoboard-web/next.config.mjs"],
    },
  };
}

test("provenance audit accepts exact single-owner coverage of native source files", () => {
  withFixture((root, document) => {
    const result = validateNativeSourceProvenance(document, root);
    assert.deepEqual(result, {
      ok: true,
      issues: [],
      sourceFiles: ["apps/eqoboard-web/app/page.tsx", "apps/eqoboard-web/next.config.mjs"],
    });
  });
});

test("provenance audit rejects a source path claimed by multiple owners", () => {
  withFixture((root, document) => {
    document.records.push({
      agent: "duplicate_owner",
      source_provenance: { classification: "first-party" },
      files: ["apps/eqoboard-web/app/page.tsx"],
    });
    const result = validateNativeSourceProvenance(document, root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.includes("source-path-must-have-exactly-one-owner")));
  });
});

test("provenance audit rejects unresolved source status and blocks the report", () => {
  withFixture((root, document) => {
    document.unverified = [{
      path: "apps/eqoboard-web/app/page.tsx",
      status: "UNVERIFIED",
      blocking: true,
      reason: "Source ownership has not been resolved.",
    }];
    const result = validateNativeSourceProvenance(document, root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.includes("UNVERIFIED")));
  });
});

test("provenance audit rejects native source files missing from the owner records", () => {
  withFixture((root, document) => {
    writeFileSync(path.join(root, "apps/eqoboard-web/app/unowned.ts"), "export const value = 1;\n");
    const result = validateNativeSourceProvenance(document, root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("unowned-native-source-file: apps/eqoboard-web/app/unowned.ts"));
  });
});

test("provenance audit rejects directory-only and nonexistent owner entries", () => {
  withFixture((root, document) => {
    document.records[0].files = ["apps/eqoboard-web/app/"];
    const result = validateNativeSourceProvenance(document, root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.includes("absolute-or-directory-only-owner-path")));
  });
});

test("provenance audit rejects unresolved source-reference paths", () => {
  withFixture((root, document) => {
    document.records[0].source_provenance.adapted_sources = [{
      sourcePath: "apps/eqoboard-web/missing-source.ts",
    }];
    const result = validateNativeSourceProvenance(document, root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.includes("source-reference-path-does-not-exist")));
  });
});

test("provenance audit prevents private absolute paths from entering the public report", () => {
  withFixture((root, document) => {
    document.records[0].source_provenance.privateEvidence = "/Users/example/Documents/Codex/private/report.json";
    const result = validateNativeSourceProvenance(document, root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("private-absolute-path-present-in-public-provenance"));
  });
});

test("provenance audit rejects empty owner records", () => {
  withFixture((root, document) => {
    document.records.push({ agent: "empty_owner", files: [] });
    const result = validateNativeSourceProvenance(document, root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("empty-owner-file-list: empty_owner"));
  });
});
