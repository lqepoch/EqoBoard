import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { classifyOpenbbE2e } from "./openbb-e2e-route.mjs";

const SAFE_WIDGET = "apps/openterminal/web/components/widgets/ChartWidget.tsx";
const MAIN_CHART_PANEL = "apps/openterminal/web/components/terminal/MainChartPanel.tsx";
const SENSITIVE_UI = "apps/openterminal/web/components/Sidebar.tsx";

function withRepo(callback, initialPaths = [SAFE_WIDGET]) {
  const root = mkdtempSync(join(tmpdir(), "eqoboard-openbb-route-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "CI route test");
    git("config", "user.email", "ci-route@example.invalid");
    for (const path of initialPaths) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "base\n");
    }
    git("add", ".");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD");
    const classify = () => classifyOpenbbE2e({
      eventName: "pull_request",
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

test("skips only a modification to an explicitly isolated terminal widget", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, SAFE_WIDGET);
    commit(git);
    assert.deepEqual(classify(), { run: false, reason: "isolated-terminal-ui-only" });
  });
});

test("skips isolated daily terminal presentation leaves", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, MAIN_CHART_PANEL);
    commit(git);
    assert.deepEqual(classify(), { run: false, reason: "isolated-terminal-ui-only" });
  }, [MAIN_CHART_PANEL]);
});

test("runs for shared runtime, auth, dependency, tooling, and tested navigation paths", () => {
  for (const path of [
    "Cargo.lock",
    "apps/gateway/src/lib.rs",
    "trading-core/market-contracts/Cargo.toml",
    "apps/openterminal/web/app/api/research/auth-check/route.ts",
    "apps/openterminal/web/lib/research-route-access.ts",
    "apps/openterminal/web/components/CommandPalette.tsx",
    "apps/openterminal/web/components/terminal/ModernTerminal.tsx",
    "apps/openterminal/web/components/terminal/PaperTradingPanel.tsx",
    "apps/openterminal/web/components/TerminalShell.tsx",
    "apps/openterminal/web/components/Terminal.tsx",
    "apps/openterminal/web/e2e/openbb-lite.spec.ts",
    "apps/openterminal/package-lock.json",
    "apps/openterminal/Dockerfile",
    "compose.yaml",
    ".github/workflows/ci.yml",
    "tools/openbb-lite-e2e.sh",
  ]) {
    withRepo(({ root, git, classify }) => {
      modify(root, path);
      commit(git);
      assert.equal(classify().run, true, `${path} must require the native OpenBB suite`);
    }, [SAFE_WIDGET, path]);
  }
});

test("mixed UI and shared changes run the full suite", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, SAFE_WIDGET);
    modify(root, "apps/openterminal/web/app/api/openbb/[...path]/route.ts");
    commit(git);
    assert.equal(classify().run, true);
  }, [SAFE_WIDGET, "apps/openterminal/web/app/api/openbb/[...path]/route.ts"]);
});

test("renames and deletes require the full suite", () => {
  withRepo(({ root, git, classify }) => {
    git("mv", SAFE_WIDGET, "apps/openterminal/web/components/widgets/HeatmapWidget.tsx");
    commit(git, "rename widget");
    assert.equal(classify().run, true);
  });

  withRepo(({ root, git, classify }) => {
    rmSync(join(root, SAFE_WIDGET));
    commit(git, "delete widget");
    assert.equal(classify().run, true);
  });
});

test("empty, unavailable, invalid, and non-PR comparisons fail closed", () => {
  withRepo(({ git, baseSha, classify }) => {
    assert.deepEqual(classify(), { run: true, reason: "empty-diff" });
    assert.equal(classifyOpenbbE2e({ eventName: "pull_request", baseSha, headSha: "f".repeat(40), cwd: process.cwd() }).run, true);
    assert.equal(classifyOpenbbE2e({ eventName: "pull_request", baseSha: "", headSha: baseSha }).run, true);
    assert.equal(classifyOpenbbE2e({ eventName: "push", baseSha, headSha: baseSha }).run, true);
  });
});

test("ambiguous merge bases and malformed diffs fail closed", () => {
  const baseSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  const validInput = { eventName: "pull_request", baseSha, headSha };
  const ambiguous = classifyOpenbbE2e({
    ...validInput,
    git: () => ({ ok: true, stdout: Buffer.from(`${baseSha}\n${headSha}\n`) }),
  });
  assert.deepEqual(ambiguous, { run: true, reason: "ambiguous-merge-base" });

  const malformed = classifyOpenbbE2e({
    ...validInput,
    git: (_cwd, args) => args[0] === "merge-base"
      ? { ok: true, stdout: Buffer.from(`${baseSha}\n`) }
      : { ok: true, stdout: Buffer.from("R100\0old.tsx\0") },
  });
  assert.deepEqual(malformed, { run: true, reason: "malformed-diff" });
});

test("CLI keeps human routing logs out of the GitHub output file", () => {
  const root = mkdtempSync(join(tmpdir(), "eqoboard-openbb-route-cli-"));
  const outputPath = join(root, "github-output.txt");
  const script = new URL("./openbb-e2e-route.mjs", import.meta.url);
  try {
    const result = spawnSync(process.execPath, [script.pathname, "push", "", ""], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^OpenBB Lite E2E route: full \(non-pull-request-event\)\n$/);
    assert.equal(readFileSync(outputPath, "utf8"), "run=true\nreason=non-pull-request-event\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tested auth and navigation surfaces stay outside the UI allowlist", () => {
  withRepo(({ root, git, classify }) => {
    modify(root, SENSITIVE_UI);
    commit(git);
    assert.deepEqual(classify(), { run: true, reason: "outside-safe-ui-allowlist" });
  }, [SENSITIVE_UI]);
});
