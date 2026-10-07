import { defineConfig } from "@playwright/test";

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a valid TCP port`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return port;
}

const webOrigin = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3300";
const oidcOrigin = process.env.E2E_OIDC_ORIGIN;
const webPort = readPort("E2E_WEB_PORT", Number(new URL(webOrigin).port || 3300));
const oidcPort = readPort("E2E_OIDC_PORT", 4310);
const gatewayPort = readPort("E2E_GATEWAY_PORT", 4311);
const researchPort = readPort("E2E_RESEARCH_PORT", 4312);
const webUrl = webOrigin;
const oidcUrl = oidcOrigin ?? `http://127.0.0.1:${oidcPort}`;

if (new URL(webUrl).port && Number(new URL(webUrl).port) !== webPort) {
  throw new Error("E2E_WEB_ORIGIN port must match E2E_WEB_PORT");
}
if (oidcOrigin && new URL(oidcOrigin).port && Number(new URL(oidcOrigin).port) !== oidcPort) {
  throw new Error("E2E_OIDC_ORIGIN port must match E2E_OIDC_PORT");
}

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
  webServer: [
    {
      command: "node e2e/mock-services.mjs",
      url: `${oidcUrl}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${webPort}`,
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
        EQO_RUST_URL: `http://127.0.0.1:${gatewayPort}`,
        API_URL: `http://127.0.0.1:${researchPort}`,
      },
    },
  ],
});
