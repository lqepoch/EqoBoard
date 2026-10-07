import { defineConfig } from "@playwright/test";

const oidcUrl = "http://127.0.0.1:4310";
const webUrl = "http://127.0.0.1:3300";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
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
  webServer: [
    {
      command: "node e2e/mock-services.mjs",
      url: `${oidcUrl}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3300",
      url: `${webUrl}/api/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXTAUTH_URL: webUrl,
        NEXTAUTH_SECRET: "nextauth-e2e-secret-that-is-at-least-32-characters-long",
        EQO_SESSION_TTL_SECONDS: process.env.E2E_SESSION_TTL_SECONDS ?? "30",
        EQO_PUBLIC_ORIGIN: webUrl,
        EQO_OIDC_ISSUER: oidcUrl,
        EQO_OIDC_CLIENT_ID: "eqo-test",
        EQO_OIDC_CLIENT_SECRET: "test-secret",
        EQO_GATEWAY_JWT_SECRET: "b".repeat(64),
        EQO_RESEARCH_JWT_SECRET: "r".repeat(64),
        EQO_RESEARCH_API_KEY: "research-service-test-key-that-is-at-least-32-bytes",
        EQO_RUST_URL: "http://127.0.0.1:4311",
        API_URL: "http://127.0.0.1:4312",
      },
    },
  ],
});
