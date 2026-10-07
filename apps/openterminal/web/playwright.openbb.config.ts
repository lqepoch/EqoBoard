import { defineConfig } from "@playwright/test";

const researchOrigin = process.env.EQO_RESEARCH_PUBLIC_ORIGIN;
if (!researchOrigin) throw new Error("EQO_RESEARCH_PUBLIC_ORIGIN is required for the OpenBB E2E profile");

export default defineConfig({
  testDir: "./e2e",
  testMatch: process.env.OPENBB_E2E_RECOVERY_ONLY ? "openbb-recovery.spec.ts" : "openbb-lite.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: process.env.OPENBB_E2E_JSON_REPORT ?? "/tmp/openbb-e2e-results.json" }]],
  outputDir: process.env.OPENBB_E2E_ARTIFACT_DIR
    ? `${process.env.OPENBB_E2E_ARTIFACT_DIR}/playwright-results`
    : "test-results/openbb",
  use: {
    baseURL: researchOrigin,
    viewport: { width: 1720, height: 1250 },
    // Browser traces persist request cookies and bearer headers. Keep local
    // screenshots/report evidence without creating credential-bearing traces.
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
});
