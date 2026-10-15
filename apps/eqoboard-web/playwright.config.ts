import { defineConfig, devices } from "@playwright/test";

const origin = process.env.E2E_WEB_ORIGIN;
if (!origin || !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/u.test(origin)) {
  throw new Error("E2E_WEB_ORIGIN must name the isolated Actions loopback fixture");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["line"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  outputDir: "test-results/browser",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: ["--host-resolver-rules=MAP native-mock-oidc 127.0.0.1", "--no-proxy-server"],
    },
  },
});
