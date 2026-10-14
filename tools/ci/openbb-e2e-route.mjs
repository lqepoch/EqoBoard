#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Only these isolated terminal widgets are outside the native OpenBB E2E
// surface. Keep this exact allowlist small: new paths default to the full test.
const SAFE_UI_PATHS = new Set([
  "apps/openterminal/web/components/widgets/AiWidget.tsx",
  "apps/openterminal/web/components/widgets/CalendarWidget.tsx",
  "apps/openterminal/web/components/widgets/ChartWidget.tsx",
  "apps/openterminal/web/components/widgets/CryptoWidget.tsx",
  "apps/openterminal/web/components/widgets/HeatmapWidget.tsx",
  "apps/openterminal/web/components/widgets/InsiderWidget.tsx",
  "apps/openterminal/web/components/widgets/IvSkewWidget.tsx",
  "apps/openterminal/web/components/widgets/MacroWidget.tsx",
  "apps/openterminal/web/components/widgets/NewsWidget.tsx",
  "apps/openterminal/web/components/widgets/OptionTapeWidget.tsx",
  "apps/openterminal/web/components/widgets/RecapWidget.tsx",
  "apps/openterminal/web/components/widgets/ScreenerWidget.tsx",
  "apps/openterminal/web/components/widgets/TvWidget.tsx",
  "apps/openterminal/web/components/widgets/WatchlistWidget.tsx",
  // Terminal presentation leaves are covered by the lighter UI/unit lanes.
  // Keep the shell, auth/navigation, and order-entry components excluded.
  "apps/openterminal/web/components/terminal/MainChartPanel.tsx",
  "apps/openterminal/web/components/terminal/OrderBookPanel.tsx",
  "apps/openterminal/web/components/terminal/TerminalHeader.tsx",
  "apps/openterminal/web/components/terminal/TerminalStatusBar.tsx",
  "apps/openterminal/web/components/terminal/WatchlistPanel.tsx",
]);

const FULL = (reason) => ({ run: true, reason });

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { ok: false };
  return { ok: true, stdout: result.stdout };
}

function classifyNameStatus(output) {
  if (!output.length) return FULL("empty-diff");
  if (output.at(-1) !== 0) return FULL("malformed-diff");
  const fields = output.toString("utf8").split("\0");
  fields.pop();
  if (fields.length === 0) return FULL("empty-diff");

  const changedPaths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^[A-Z][0-9]*$/.test(status)) return FULL("malformed-diff");
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount || paths.some((path) => path.length === 0)) {
      return FULL("malformed-diff");
    }
    index += pathCount;

    // Renames, copies, additions, deletes, type changes, and all unknown
    // statuses require the complete native suite even if the names look safe.
    if (status !== "M") return FULL("non-modification-change");
    changedPaths.push(...paths);
  }

  if (changedPaths.length === 0) return FULL("empty-diff");
  if (!changedPaths.every((path) => SAFE_UI_PATHS.has(path))) return FULL("outside-safe-ui-allowlist");
  return { run: false, reason: "isolated-terminal-ui-only" };
}

export function classifyOpenbbE2e({ eventName, baseSha, headSha, cwd = REPO_ROOT, git = runGit }) {
  if (eventName !== "pull_request") return FULL("non-pull-request-event");
  const validSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
  if (!validSha.test(baseSha ?? "") || !validSha.test(headSha ?? "")) return FULL("missing-or-invalid-sha");

  const mergeBase = git(cwd, ["merge-base", "--all", baseSha, headSha]);
  if (!mergeBase.ok) return FULL("merge-base-unavailable");
  const bases = mergeBase.stdout.toString("utf8").trim().split(/\s+/).filter(Boolean);
  if (bases.length !== 1 || !validSha.test(bases[0])) return FULL("ambiguous-merge-base");

  const diff = git(cwd, ["diff", "--name-status", "-z", "--find-renames", bases[0], headSha]);
  if (!diff.ok) return FULL("diff-unavailable");
  return classifyNameStatus(diff.stdout);
}

function main() {
  const [eventName, baseSha = "", headSha = ""] = process.argv.slice(2);
  const result = classifyOpenbbE2e({ eventName, baseSha, headSha });
  const output = `run=${result.run}\nreason=${result.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output, { encoding: "utf8" });
  process.stdout.write(`OpenBB Lite E2E route: ${result.run ? "full" : "skip"} (${result.reason})\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
