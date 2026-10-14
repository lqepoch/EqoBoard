import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { classifyNameStatus, classifyOpenbbCi } from "./openbb-ci-route.mjs";

const SAFE_WIDGET = "apps/openterminal/web/components/widgets/ChartWidget.tsx";

function withRepo(callback, initialPaths = [SAFE_WIDGET]) {
  const root = mkdtempSync(join(tmpdir(), "eqoboard-openbb-ci-route-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "OpenBB CI route test");
    git("config", "user.email", "openbb-ci-route@example.invalid");
    for (const path of initialPaths) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "base\n");
    }
    git("add", ".");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD");
    const classify = (eventName = "pull_request") => classifyOpenbbCi({
      eventName,
      baseSha,
      headSha: git("rev-parse", "HEAD"),
      cwd: root,
    });
    callback({ root, git, baseSha, classify });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function modify(root, path, content = "changed\n") {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(git, message = "change") {
  git("add", "-A");
  git("commit", "-qm", message);
}

test("isolated terminal presentation changes keep both heavy OpenBB lanes skipped", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, SAFE_WIDGET);
    commit(git);
    assert.deepEqual(classify(), { source: false, runtime: false, reason: "unrelated-paths" });
  });
});

test("unknown UI leaves and non-modification changes select runtime validation", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, "apps/openterminal/web/components/widgets/NewWidget.tsx");
    commit(git, "add UI component");
    assert.deepEqual(classify(), { source: false, runtime: true, reason: "related-paths" });
  });
  withRepo(({ root, git, classify }) => {
    rmSync(join(root, SAFE_WIDGET));
    commit(git, "delete isolated widget");
    assert.equal(classify().runtime, true);
  });
  withRepo(({ root, git, classify }) => {
    git("mv", SAFE_WIDGET, "README.md");
    commit(git, "rename UI component");
    assert.equal(classify().runtime, true);
  });
});

test("routes source supply-chain changes without forcing the browser runtime lane", () => {
  for (const path of [
    "tools/openbb/source-sbom.sh",
    "tests/test_openbb_supply_chain.py",
  ]) {
    withRepo(({ root, git, classify }) => {
      modify(root, path);
      commit(git);
      assert.deepEqual(classify(), { source: true, runtime: false, reason: "related-paths" }, path);
    }, [SAFE_WIDGET, path]);
  }
});

test("mixed provenance and suite ownership contracts select both lanes", () => {
  for (const path of ["tests/test_upstream_provenance.py", "tests/test_ci_contract_test_split.py"]) {
    withRepo(({ root, git, classify }) => {
      modify(root, path);
      commit(git);
      assert.deepEqual(classify(), { source: true, runtime: true, reason: "related-paths" }, path);
    }, [SAFE_WIDGET, path]);
  }
});

test("routes shared authentication, BFF, Gateway, domain, dependency, Compose, and CI inputs", () => {
  for (const path of [
    "apps/openterminal/web/app/api/research/auth-check/route.ts",
    "apps/openterminal/web/app/api/openbb/[...path]/route.ts",
    "apps/openterminal/web/auth.ts",
    "apps/openterminal/web/middleware.ts",
    "apps/openterminal/web/lib/research-origin.ts",
    "apps/openterminal/web/components/CommandPalette.tsx",
    "apps/openterminal/web/e2e/openbb-lite.spec.ts",
    "apps/openterminal/web/e2e/research-bff.spec.ts",
    "apps/openterminal/web/e2e/mock-openbb-oidc.mjs",
    "apps/openterminal/web/e2e/access-boundary.spec.ts",
    "apps/openterminal/web/e2e/fixtures.ts",
    "apps/openterminal/web/e2e/isolated-env.ts",
    "apps/openterminal/web/e2e/mdp-upstream.ts",
    "apps/openterminal/web/e2e/quant-upstream.ts",
    "apps/openterminal/web/playwright.openbb.config.ts",
    "apps/openterminal/web/playwright.research.config.ts",
    "apps/openterminal/server/src/auth.ts",
    "apps/gateway/openbb/widgets.json",
    "apps/gateway/src/main.rs",
    "crates/domain/src/lib.rs",
    "trading-core/market-contracts/Cargo.toml",
    "Cargo.toml",
    "Cargo.lock",
    "apps/openterminal/package-lock.json",
    "compose.openbb.e2e.yaml",
    ".github/workflows/openbb.yml",
    "tools/ci/openbb-ci-route.mjs",
    "tools/auto_merge/required-checks.json",
    "tools/openbb-lite-e2e.sh",
    "tools/openbb/openbb-release-compose.sh",
  ]) {
    withRepo(({ root, git, classify }) => {
      modify(root, path);
      commit(git);
      const bothLanes = path.startsWith(".github/")
        || path.startsWith("tools/ci/")
        || path.startsWith("tools/auto_merge/");
      const sourceSelected = bothLanes || path.startsWith("tools/openbb/");
      assert.deepEqual(classify(), { source: sourceSelected, runtime: true, reason: "related-paths" }, path);
    }, [SAFE_WIDGET, path]);
  }
});

test("unrelated local market-data and workstation helpers do not select OpenBB lanes", () => {
  for (const path of [
    "tools/qqq_sip_quota_probe.py",
    "tools/qqq_sip_weekly_export.py",
    "tools/check_alpaca_feeds.py",
    "tools/futu-stdio.mjs",
    "tools/futu-subscriptions.mjs",
    "tools/futu-subscriptions.test.mjs",
    "tools/local-access.test.ts",
    "tools/upstream_diff.py",
    "tests/test_upstream_diff.py",
    "apps/openterminal/web/e2e/market-order.spec.ts",
    "apps/openterminal/web/e2e/market-stream.spec.ts",
    "apps/openterminal/web/e2e/market-data-bff.spec.ts",
    "apps/openterminal/web/e2e/market-data-chart.spec.ts",
    "apps/openterminal/web/e2e/engine-offline-preview.spec.ts",
    "apps/openterminal/web/e2e/mock-services.mjs",
    "apps/openterminal/web/e2e/market-test-data.ts",
    "apps/openterminal/web/e2e/compose-e2e-server.mjs",
    "apps/openterminal/web/playwright.config.ts",
    "apps/openterminal/web/playwright.compose.config.ts",
  ]) {
    withRepo(({ root, git, classify }) => {
      modify(root, path);
      commit(git);
      assert.deepEqual(classify(), { source: false, runtime: false, reason: "unrelated-paths" }, path);
    }, [SAFE_WIDGET, path]);
  }
});

test("mixed changes select both lanes", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, SAFE_WIDGET);
    modify(root, "apps/gateway/openbb/widgets.json");
    commit(git);
    assert.deepEqual(classify(), { source: false, runtime: true, reason: "related-paths" });
  });
});

test("renames route both the old and new path names", () => {
  withRepo(({ root, git, classify }) => {
    const oldPath = "tests/test_openbb_supply_chain.py";
    const newPath = "README.md";
    git("mv", oldPath, newPath);
    commit(git, "rename source test");
    assert.deepEqual(classify(), { source: true, runtime: false, reason: "related-paths" });
  }, [SAFE_WIDGET, "tests/test_openbb_supply_chain.py"]);
  withRepo(({ root, git, classify }) => {
    git("mv", "apps/gateway/openbb/apps.json", "README.md");
    commit(git, "rename Gateway manifest");
    assert.deepEqual(classify(), { source: false, runtime: true, reason: "related-paths" });
  }, [SAFE_WIDGET, "apps/gateway/openbb/apps.json"]);
  withRepo(({ root, git, classify }) => {
    git("mv", "README.md", "apps/gateway/openbb/apps.json");
    commit(git, "move file into Gateway manifest path");
    assert.deepEqual(classify(), { source: false, runtime: true, reason: "related-paths" });
  }, [SAFE_WIDGET, "README.md"]);
});

test("deletes and additions preserve the related path route", () => {
  withRepo(({ root, git, classify }) => {
    rmSync(join(root, "apps/gateway/openbb/apps.json"));
    commit(git, "remove gateway manifest");
    assert.equal(classify().runtime, true);
  }, [SAFE_WIDGET, "apps/gateway/openbb/apps.json"]);
  withRepo(({ root, git, classify }) => {
    const path = "apps/gateway/openbb/new-manifest.json";
    modify(root, path);
    commit(git, "add gateway manifest");
    assert.equal(classify().runtime, true);
  });
});

test("unrelated additions, deletions, and renames keep heavy lanes skipped", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, "docs/new-note.md");
    commit(git, "add unrelated documentation");
    assert.deepEqual(classify(), { source: false, runtime: false, reason: "unrelated-paths" });
  });
  withRepo(({ root, git, classify }) => {
    rmSync(join(root, "docs/old-note.md"));
    commit(git, "delete unrelated documentation");
    assert.deepEqual(classify(), { source: false, runtime: false, reason: "unrelated-paths" });
  }, [SAFE_WIDGET, "docs/old-note.md"]);
  withRepo(({ root, git, classify }) => {
    git("mv", "docs/old-note.md", "README.md");
    commit(git, "rename unrelated documentation");
    assert.deepEqual(classify(), { source: false, runtime: false, reason: "unrelated-paths" });
  }, [SAFE_WIDGET, "docs/old-note.md"]);
});

test("manual and weekly events always select both heavy lanes", () => {
  for (const eventName of ["workflow_dispatch", "schedule", "push", "unknown"]) {
    const result = classifyOpenbbCi({ eventName, baseSha: "", headSha: "" });
    assert.equal(result.source, true, eventName);
    assert.equal(result.runtime, true, eventName);
  }
});

test("valid status codes classify every old and new path", () => {
  assert.deepEqual(classifyNameStatus(Buffer.from("R100\0README.md\0apps/gateway/openbb/apps.json\0", "utf8")), {
    source: false, runtime: true, reason: "related-paths",
  });
  assert.deepEqual(classifyNameStatus(Buffer.from("C75\0tests/test_openbb_supply_chain.py\0README.md\0", "utf8")), {
    source: true, runtime: false, reason: "related-paths",
  });
  assert.deepEqual(classifyNameStatus(Buffer.from("T\0apps/gateway/openbb/apps.json\0", "utf8")), {
    source: false, runtime: true, reason: "related-paths",
  });
  assert.deepEqual(classifyNameStatus(Buffer.from("A\0docs/new.md\0", "utf8")), {
    source: false, runtime: false, reason: "unrelated-paths",
  });
});

test("empty, malformed, unavailable, or ambiguous Git comparisons fail closed", () => {
  const baseSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  assert.deepEqual(classifyNameStatus(Buffer.alloc(0)), {
    source: true, runtime: true, reason: "malformed-or-empty-diff",
  });
  assert.deepEqual(classifyNameStatus(Buffer.from("M\0path.ts\0", "utf8").subarray(0, 8)), {
    source: true, runtime: true, reason: "malformed-or-empty-diff",
  });
  assert.deepEqual(classifyNameStatus(Buffer.from("Z\0path.ts\0", "utf8")), {
    source: true, runtime: true, reason: "malformed-or-empty-diff",
  });
  for (const malformed of [
    "U\0README.md\0",
    "X\0README.md\0",
    "B\0README.md\0",
    "A1\0README.md\0",
    "R\0old.md\0new.md\0",
    "R101\0old.md\0new.md\0",
    "M\0../README.md\0",
    "M\0/apps/gateway/main.rs\0",
    "M\0apps\\gateway\\main.rs\0",
  ]) {
    assert.deepEqual(classifyNameStatus(Buffer.from(malformed, "utf8")), {
      source: true, runtime: true, reason: "malformed-or-empty-diff",
    }, malformed);
  }
  assert.deepEqual(classifyNameStatus(Buffer.from([0x4d, 0, 0xff, 0])), {
    source: true, runtime: true, reason: "malformed-or-empty-diff",
  });
  const input = { eventName: "pull_request", baseSha, headSha };
  assert.equal(classifyOpenbbCi({ ...input, baseSha: "", cwd: process.cwd() }).source, true);
  assert.equal(classifyOpenbbCi({
    ...input,
    git: () => ({ ok: true, stdout: Buffer.from(`${baseSha}\n${headSha}\n`) }),
  }).runtime, true);
  assert.equal(classifyOpenbbCi({ ...input, git: () => ({ ok: false }) }).source, true);
});

test("CLI writes machine-readable route outputs separately from its summary", () => {
  const root = mkdtempSync(join(tmpdir(), "eqoboard-openbb-ci-route-cli-"));
  const outputPath = join(root, "github-output.txt");
  try {
    const result = spawnSync(process.execPath, [
      new URL("./openbb-ci-route.mjs", import.meta.url).pathname,
      "push",
      "",
      "",
    ], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^OpenBB CI route: source=true runtime=true \(missing-or-invalid-sha\)\n$/);
    assert.equal(readFileSync(outputPath, "utf8"), "source=true\nruntime=true\nreason=missing-or-invalid-sha\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

