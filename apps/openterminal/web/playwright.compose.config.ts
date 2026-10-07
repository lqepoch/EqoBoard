import { defineConfig } from "@playwright/test";

const webUrl = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  testIgnore: "research-bff.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
