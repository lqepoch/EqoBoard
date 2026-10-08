import { defineConfig } from "@playwright/test";
import { assertHostE2eEnvironmentIsIsolated } from "./e2e/isolated-env";
import { mdpUpstreamUrl } from "./e2e/mdp-upstream";
import { quantUpstreamUrl } from "./e2e/quant-upstream";

assertHostE2eEnvironmentIsIsolated();

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a valid TCP port`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return port;
}

const oidcPort = readPort("E2E_OIDC_PORT", 4320);
const webPort = readPort("E2E_RESEARCH_WEB_PORT", 3320);
const sameHostnamePort = readPort("E2E_RESEARCH_SAME_HOSTNAME_PORT", 3321);
const credentialPort = readPort("E2E_RESEARCH_CREDENTIAL_PORT", 3322);
const gatewayPort = readPort("E2E_GATEWAY_PORT", 4321);
const researchPort = readPort("E2E_RESEARCH_PORT", 4322);
const mdpPort = readPort("E2E_MDP_PORT", 4323);
const quantPort = readPort("E2E_QUANT_PORT", 4324);
const enginePort = readPort("E2E_ENGINE_PORT", 4325);
const oidcUrl = process.env.E2E_OIDC_ORIGIN ?? `http://127.0.0.1:${oidcPort}`;
const webUrl = process.env.E2E_WEB_ORIGIN ?? `http://127.0.0.1:${webPort}`;
const mdpUrl = mdpUpstreamUrl(process.env.E2E_MDP_UPSTREAM_URL, mdpPort);
const quantUrl = quantUpstreamUrl(process.env.E2E_QUANT_UPSTREAM_URL, quantPort);
const sameHostnameWebUrl = `http://127.0.0.1:${sameHostnamePort}`;
const credentialWebUrl = `http://127.0.0.1:${credentialPort}`;

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
        E2E_OIDC_PORT: String(oidcPort),
        E2E_GATEWAY_PORT: String(gatewayPort),
        E2E_RESEARCH_PORT: String(researchPort),
        E2E_MDP_PORT: String(mdpPort),
        E2E_QUANT_PORT: String(quantPort),
        E2E_ENGINE_PORT: String(enginePort),
        E2E_WEB_ORIGIN: webUrl,
        E2E_OIDC_ORIGIN: oidcUrl,
      },
    },
    {
      command: `npm run start -- --hostname 127.0.0.1 --port ${webPort}`,
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
        MDP_RESEARCH_JWT_SECRET: "q".repeat(64),
        QUANT_RESEARCH_JWT_SECRET: "u".repeat(64),
        EQO_RESEARCH_API_KEY: "",
        ALPACA_KEY: "",
        ALPACA_SECRET: "",
        EQO_RUST_URL: `http://127.0.0.1:${gatewayPort}`,
        EQO_MDP_URL: mdpUrl,
        EQO_QUANT_RESEARCH_URL: quantUrl,
      },
    },
    {
      command: `npm run start -- --hostname 127.0.0.1 --port ${sameHostnamePort}`,
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
        MDP_RESEARCH_JWT_SECRET: "q".repeat(64),
        QUANT_RESEARCH_JWT_SECRET: "u".repeat(64),
        EQO_RESEARCH_API_KEY: "",
        ALPACA_KEY: "",
        ALPACA_SECRET: "",
        EQO_RUST_URL: `http://127.0.0.1:${gatewayPort}`,
        EQO_MDP_URL: mdpUrl,
        EQO_QUANT_RESEARCH_URL: quantUrl,
      },
    },
    {
      command: `npm run start -- --hostname 127.0.0.1 --port ${credentialPort}`,
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
        MDP_RESEARCH_JWT_SECRET: "q".repeat(64),
        QUANT_RESEARCH_JWT_SECRET: "u".repeat(64),
        EQO_RESEARCH_API_KEY: "",
        ALPACA_KEY: "mock-market-key-must-not-enter-research",
        ALPACA_SECRET: "mock-market-secret-must-not-enter-research",
        EQO_RUST_URL: `http://127.0.0.1:${gatewayPort}`,
        EQO_MDP_URL: mdpUrl,
        EQO_QUANT_RESEARCH_URL: quantUrl,
      },
    },
  ],
});
