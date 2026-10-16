import { defineConfig, devices } from "@playwright/test";

const origin = process.env.E2E_LOCAL_ORIGIN;
if (origin !== "http://127.0.0.1:3000") {
  throw new Error("Local runtime acceptance requires the isolated Actions loopback origin");
}
export default defineConfig({
  testDir: "./local-e2e",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["line"], ["json", { outputFile: "test-results/local/results.json" }]],
  outputDir: "test-results/local/browser",
  use: {
    baseURL: origin,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
