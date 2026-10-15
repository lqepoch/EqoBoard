#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FULL = (reason) => ({ source: true, runtime: true, reason });
const GIT_COMMAND_TIMEOUT_MS = 30_000;

const ISOLATED_UI_PATHS = new Set([
  "apps/openterminal/web/components/Flash.tsx",
  "apps/openterminal/web/components/MarketStreamProvider.tsx",
  "apps/openterminal/web/components/WidgetErrorBoundary.tsx",
  "apps/openterminal/web/components/widgets/AiWidget.tsx",
  "apps/openterminal/web/components/widgets/CalendarWidget.tsx",
  "apps/openterminal/web/components/widgets/ChartWidget.tsx",
  "apps/openterminal/web/components/widgets/CryptoWidget.tsx",
  "apps/openterminal/web/components/widgets/HeatmapWidget.tsx",
  "apps/openterminal/web/components/widgets/InsiderWidget.tsx",
  "apps/openterminal/web/components/widgets/IvSkewWidget.tsx",
  "apps/openterminal/web/components/widgets/MacroWidget.tsx",
  "apps/openterminal/web/components/widgets/NewsWidget.tsx",
  "apps/openterminal/web/components/widgets/EngineOfflinePreviewWidget.tsx",
  "apps/openterminal/web/components/widgets/MarketFeedStatus.tsx",
  "apps/openterminal/web/components/widgets/OptionTapeWidget.tsx",
  "apps/openterminal/web/components/widgets/OptionsWidget.tsx",
  "apps/openterminal/web/components/widgets/OrderOutcomePanel.tsx",
  "apps/openterminal/web/components/widgets/PortfolioWidget.tsx",
  "apps/openterminal/web/components/widgets/QuoteWidget.tsx",
  "apps/openterminal/web/components/widgets/RecapWidget.tsx",
  "apps/openterminal/web/components/widgets/ResearchPredictionsWidget.tsx",
  "apps/openterminal/web/components/widgets/ScreenerWidget.tsx",
  "apps/openterminal/web/components/widgets/TvWidget.tsx",
  "apps/openterminal/web/components/widgets/VerticalSpreadWidget.tsx",
  "apps/openterminal/web/components/widgets/WatchlistWidget.tsx",
  "apps/openterminal/web/components/terminal/PaperTradingPanel.tsx",
  "apps/openterminal/web/components/terminal/MainChartPanel.tsx",
  "apps/openterminal/web/components/terminal/OrderBookPanel.tsx",
  "apps/openterminal/web/components/terminal/TerminalHeader.tsx",
  "apps/openterminal/web/components/terminal/TerminalStatusBar.tsx",
  "apps/openterminal/web/components/terminal/WatchlistPanel.tsx",
  "apps/openterminal/web/lib/engine-preview.ts",
  "apps/openterminal/web/lib/futu-native-client.ts",
  "apps/openterminal/web/lib/indicators.ts",
  "apps/openterminal/web/lib/links.ts",
  "apps/openterminal/web/lib/mdp-market-data-contract.ts",
  "apps/openterminal/web/lib/mdp-market-data.ts",
  "apps/openterminal/web/lib/order-api.ts",
  "apps/openterminal/web/lib/order-contract.ts",
  "apps/openterminal/web/lib/quant-prediction-contract.ts",
  "apps/openterminal/web/lib/quant-predictions.ts",
  "apps/openterminal/web/lib/symbol.ts",
  "apps/openterminal/web/lib/tick-aggregator.ts",
  "apps/openterminal/web/lib/eqo-market.ts",
  "apps/openterminal/web/lib/local-access.ts",
]);

const SOURCE_EXACT_PATHS = new Set([
  "third_party/upstreams.lock.json",
  "third_party/licenses/openbb-workspace/LICENSE",
  "third_party/licenses/openbb-workspace/NOTICE",
  "tests/test_upstream_provenance.py",
  "tests/test_ci_contract_test_split.py",
]);

const SOURCE_ONLY_OPENBB_TOOL_PATHS = new Set([
  "tools/openbb/fetch-upstream.sh",
  "tools/openbb/verify-upstream.sh",
  "tools/openbb/source-sbom.sh",
  "tools/openbb/patched-source-sbom.sh",
  "tools/openbb/upstream-diff.sh",
]);

const RUNTIME_EXACT_PATHS = new Set([
  ".dockerignore",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "deny.toml",
  "Dockerfile",
  "compose.yaml",
  "compose.e2e.yaml",
  "compose.openbb.yaml",
  "compose.openbb.e2e.yaml",
  "compose.openbb.release.yaml",
  "apps/openterminal/Dockerfile",
  "apps/openterminal/openbb-research-ingress.conf",
  "apps/openterminal/package.json",
  "apps/openterminal/package-lock.json",
  "apps/openterminal/server/package.json",
  "apps/openterminal/web/package.json",
  "apps/openterminal/web/auth.ts",
  "apps/openterminal/web/middleware.ts",
  "apps/openterminal/web/next.config.mjs",
  "apps/openterminal/web/next-auth.d.ts",
  "apps/openterminal/web/components/CommandPalette.tsx",
  "apps/openterminal/web/components/Sidebar.tsx",
  "apps/openterminal/web/components/SignInButton.tsx",
  "apps/openterminal/web/components/SignOutButton.tsx",
  "apps/openterminal/web/components/Terminal.tsx",
  "apps/openterminal/web/components/TerminalShell.tsx",
  "apps/openterminal/web/lib/api.ts",
  "apps/openterminal/web/lib/eqo-auth.ts",
  "apps/openterminal/web/lib/api-key.ts",
  "apps/openterminal/web/lib/http-response.ts",
  "apps/openterminal/web/lib/permissions.ts",
  "apps/openterminal/web/lib/research-origin.ts",
  "apps/openterminal/web/lib/research-route-access.ts",
  "apps/openterminal/web/app/layout.tsx",
  "apps/openterminal/web/app/page.tsx",
  "apps/openterminal/web/app/providers.tsx",
  "third_party/upstreams.lock.json",
  "tests/test_upstream_provenance.py",
  "tests/test_ci_contract_test_split.py",
  ".env.example",
]);

const RUNTIME_OPENBB_TOOL_PATHS = new Set([
  "tools/openbb/openbb_upstream.py",
  "tools/openbb/verify_docker_save_oci.py",
  "tools/openbb/build-lite.sh",
  "tools/openbb/openbb-release-compose.sh",
  "tools/openbb-lite-e2e.sh",
  "tools/openbb-sanitize-e2e-logs.mjs",
  "tools/container-e2e.sh",
]);

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
  // Git can exit successfully after rename/copy detection warnings while omitting path pairings.
  if (result.error
      || result.status !== 0
      || !Buffer.isBuffer(result.stdout)
      || !Buffer.isBuffer(result.stderr)
      || result.stderr.length > 0) return { ok: false };
  return { ok: true, stdout: result.stdout };
}

function decodeUtf8(field) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(field);
  } catch {
    return null;
  }
}

export function parseNameStatus(output) {
  if (!Buffer.isBuffer(output) || output.length === 0 || output.at(-1) !== 0) return null;
  const fields = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      fields.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== output.length || fields.length === 0) return null;

  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = decodeUtf8(fields[index++]);
    if (!status || !/^(?:[ADMT]|[RC](?:100|0?[0-9]{1,2}))$/.test(status)) return null;
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const rawPaths = fields.slice(index, index + pathCount);
    if (rawPaths.length !== pathCount || rawPaths.some((path) => path.length === 0)) return null;
    const paths = rawPaths.map(decodeUtf8);
    if (paths.some((path) => path === null || !isValidRepoPath(path))) return null;
    index += pathCount;
    entries.push({ status, paths });
  }
  return entries.length > 0 ? entries : null;
}

function isValidRepoPath(path) {
  return !path.startsWith("/")
    && !path.includes("\\")
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function startsWithPath(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isOpenbbPythonTest(path) {
  return path.startsWith("tests/test_openbb_") && path.endsWith(".py");
}

function isOpenbbE2ePath(path) {
  return path.startsWith("apps/openterminal/web/e2e/openbb-")
    || path.startsWith("apps/openterminal/web/e2e/mock-openbb-")
    || path.startsWith("apps/openterminal/web/e2e/research-")
    || path === "apps/openterminal/web/e2e/access-boundary.spec.ts"
    || path === "apps/openterminal/web/e2e/fixtures.ts"
    || path === "apps/openterminal/web/e2e/isolated-env.ts"
    || path === "apps/openterminal/web/e2e/mdp-upstream.ts"
    || path === "apps/openterminal/web/e2e/quant-upstream.ts"
    || path === "apps/openterminal/web/playwright.openbb.config.ts"
    || path === "apps/openterminal/web/playwright.research.config.ts";
}

function pathRoute(path) {
  let source = SOURCE_EXACT_PATHS.has(path) || isOpenbbPythonTest(path);
  let runtime = RUNTIME_EXACT_PATHS.has(path) || isOpenbbE2ePath(path);

  if (startsWithPath(path, "tools/openbb")) {
    source = true;
    if (!SOURCE_ONLY_OPENBB_TOOL_PATHS.has(path)) runtime = true;
  }
  if (startsWithPath(path, "tools/openbb/community")) runtime = true;
  if (startsWithPath(path, "tools/ci")
      || startsWithPath(path, "tools/auto_merge")
      || startsWithPath(path, ".github")) {
    source = true;
    runtime = true;
  }
  if (RUNTIME_OPENBB_TOOL_PATHS.has(path)) runtime = true;
  if (startsWithPath(path, "apps/gateway")
      || startsWithPath(path, "crates/domain")
      || startsWithPath(path, "crates/alpaca-data")
      || startsWithPath(path, "crates/execution")
      || startsWithPath(path, "trading-core/market-contracts")
      || startsWithPath(path, ".cargo")) {
    runtime = true;
  }
  if (path.startsWith("third_party/licenses/openbb-workspace/")) source = true;
  if (path === ".env.example") runtime = true;
  if (path === "apps/openterminal/web/app/layout.tsx"
      || path === "apps/openterminal/web/app/page.tsx"
      || path === "apps/openterminal/web/app/providers.tsx") runtime = true;
  if (startsWithPath(path, "apps/openterminal/server")) runtime = true;
  if (startsWithPath(path, "apps/openterminal/web/app/api")) runtime = true;
  if (startsWithPath(path, "apps/openterminal/web/components")) runtime = true;
  if (startsWithPath(path, "apps/openterminal/web/lib")) runtime = true;
  if (startsWithPath(path, "apps/openterminal")
      && /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(path)) runtime = true;
  if (path.startsWith("apps/openterminal/web/lib/research-")) runtime = true;
  if (path.startsWith("apps/openterminal/web/lib/openbb-")) runtime = true;
  return { source, runtime };
}

export function classifyNameStatus(output) {
  const entries = parseNameStatus(output);
  if (!entries) return FULL("malformed-or-empty-diff");
  let source = false;
  let runtime = false;
  for (const { status, paths } of entries) {
    for (const path of paths) {
      // Narrow skipping is limited to modifications of explicit presentation
      // leaves. Any add/delete/rename/type change considers every path name.
      if (status === "M" && ISOLATED_UI_PATHS.has(path)) continue;
      const route = pathRoute(path);
      source ||= route.source;
      runtime ||= route.runtime;
    }
  }
  return {
    source,
    runtime,
    reason: source || runtime ? "related-paths" : "unrelated-paths",
  };
}

export function classifyOpenbbCi({ eventName, baseSha, headSha, cwd = REPO_ROOT, git = runGit }) {
  if (eventName === "workflow_dispatch" || eventName === "schedule") return FULL("manual-or-weekly-full");
  const validSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
  if (!validSha.test(baseSha ?? "") || !validSha.test(headSha ?? "")) return FULL("missing-or-invalid-sha");

  if (eventName === "pull_request") {
    const mergeBase = git(cwd, ["merge-base", "--all", baseSha, headSha]);
    if (!mergeBase.ok) return FULL("merge-base-unavailable");
    const output = decodeUtf8(mergeBase.stdout);
    if (output === null) return FULL("invalid-merge-base-output");
    const bases = output.trim().split(/\s+/).filter(Boolean);
    if (bases.length !== 1 || !validSha.test(bases[0])) return FULL("ambiguous-merge-base");
    const diff = git(cwd, ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", bases[0], headSha]);
    if (!diff.ok) return FULL("diff-unavailable");
    return classifyNameStatus(diff.stdout);
  }

  if (eventName === "push") {
    const diff = git(cwd, ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", baseSha, headSha]);
    if (!diff.ok) return FULL("diff-unavailable");
    return classifyNameStatus(diff.stdout);
  }
  return FULL("unknown-event");
}

function main() {
  const [eventName, baseSha = "", headSha = ""] = process.argv.slice(2);
  const result = classifyOpenbbCi({ eventName, baseSha, headSha });
  const output = `source=${result.source}\nruntime=${result.runtime}\nreason=${result.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output, { encoding: "utf8" });
  process.stdout.write(`OpenBB CI route: source=${result.source} runtime=${result.runtime} (${result.reason})\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
