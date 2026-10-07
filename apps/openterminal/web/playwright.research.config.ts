import { defineConfig } from "@playwright/test";
import { assertHostE2eEnvironmentIsIsolated } from "./e2e/isolated-env";

assertHostE2eEnvironmentIsIsolated();

const oidcUrl = "http://127.0.0.1:4320";
const webUrl = "http://127.0.0.1:3320";
const sameHostnameWebUrl = "http://127.0.0.1:3321";
const credentialWebUrl = "http://127.0.0.1:3322";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "research-bff.spec.ts",
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
      env: {
        E2E_OIDC_PORT: "4320",
        E2E_GATEWAY_PORT: "4321",
        E2E_RESEARCH_PORT: "4322",
        E2E_WEB_ORIGIN: webUrl,
        E2E_OIDC_ORIGIN: oidcUrl,
      },
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3320",
      url: `${webUrl}/api/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        NEXTAUTH_URL: webUrl,
        NEXTAUTH_SECRET: "isolated-research-nextauth-secret-with-more-than-32-bytes",
        EQO_BFF_MODE: "research",
        EQO_SESSION_TTL_SECONDS: "300",
        EQO_PUBLIC_ORIGIN: webUrl,
        EQO_TERMINAL_PUBLIC_ORIGIN: "http://localhost:3000",
        EQO_OIDC_ISSUER: oidcUrl,
        EQO_OIDC_CLIENT_ID: "eqo-test",
        EQO_OIDC_CLIENT_SECRET: "test-secret",
        EQO_GATEWAY_JWT_SECRET: "",
        EQO_RESEARCH_JWT_SECRET: "r".repeat(64),
        EQO_RESEARCH_API_KEY: "",
        ALPACA_KEY: "",
        ALPACA_SECRET: "",
        EQO_RUST_URL: "http://127.0.0.1:4321",
      },
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3321",
      url: `${sameHostnameWebUrl}/api/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        NEXTAUTH_URL: sameHostnameWebUrl,
        NEXTAUTH_SECRET: "isolated-research-nextauth-secret-with-more-than-32-bytes",
        EQO_BFF_MODE: "research",
        EQO_SESSION_TTL_SECONDS: "300",
        EQO_PUBLIC_ORIGIN: sameHostnameWebUrl,
        EQO_TERMINAL_PUBLIC_ORIGIN: webUrl,
        EQO_OIDC_ISSUER: oidcUrl,
        EQO_OIDC_CLIENT_ID: "eqo-test",
        EQO_OIDC_CLIENT_SECRET: "test-secret",
        EQO_GATEWAY_JWT_SECRET: "",
        EQO_RESEARCH_JWT_SECRET: "r".repeat(64),
        EQO_RESEARCH_API_KEY: "",
        ALPACA_KEY: "",
        ALPACA_SECRET: "",
        EQO_RUST_URL: "http://127.0.0.1:4321",
      },
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3322",
      url: `${credentialWebUrl}/api/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        NEXTAUTH_URL: credentialWebUrl,
        NEXTAUTH_SECRET: "isolated-research-nextauth-secret-with-more-than-32-bytes",
        EQO_BFF_MODE: "research",
        EQO_SESSION_TTL_SECONDS: "300",
        EQO_PUBLIC_ORIGIN: credentialWebUrl,
        EQO_TERMINAL_PUBLIC_ORIGIN: "http://localhost:3000",
        EQO_OIDC_ISSUER: oidcUrl,
        EQO_OIDC_CLIENT_ID: "eqo-test",
        EQO_OIDC_CLIENT_SECRET: "test-secret",
        EQO_GATEWAY_JWT_SECRET: "",
        EQO_RESEARCH_JWT_SECRET: "r".repeat(64),
        EQO_RESEARCH_API_KEY: "",
        ALPACA_KEY: "mock-market-key-must-not-enter-research",
        ALPACA_SECRET: "mock-market-secret-must-not-enter-research",
        EQO_RUST_URL: "http://127.0.0.1:4321",
      },
    },
  ],
});
