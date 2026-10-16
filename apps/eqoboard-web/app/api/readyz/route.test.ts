import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

function clearRuntimeEnvironment(): void {
  for (const name of [
    "EQO_LOCAL_ACCESS",
    "EQO_LOCAL_BIND",
    "EQO_BFF_MODE",
    "HOSTNAME",
    "PORT",
    "EQO_PUBLIC_ORIGIN",
    "NEXTAUTH_URL",
    "NEXTAUTH_SECRET",
    "EQO_OIDC_ISSUER",
    "EQO_OIDC_CLIENT_ID",
    "EQO_OIDC_CLIENT_SECRET",
    "EQO_SESSION_TTL_SECONDS",
    "EQO_GATEWAY_JWT_SECRET",
    "MDP_TERMINAL_JWT_SECRET",
    "QUANT_TERMINAL_JWT_SECRET",
    "ENGINE_TERMINAL_JWT_SECRET",
    "EQO_RESEARCH_JWT_SECRET",
    "MDP_RESEARCH_JWT_SECRET",
    "QUANT_RESEARCH_JWT_SECRET",
    "ENGINE_RESEARCH_JWT_SECRET",
    "EQO_RESEARCH_API_KEY",
    "ALPACA_KEY",
    "ALPACA_SECRET",
    "EQO_ADAPTER_ALPACA_TOKEN",
    "EQO_ADAPTER_IBKR_TOKEN",
    "EQO_ADAPTER_SCHWAB_TOKEN",
    "ANTHROPIC_API_KEY",
  ]) {
    vi.stubEnv(name, "");
  }
}

function setLocalEnvironment(): void {
  clearRuntimeEnvironment();
  vi.stubEnv("EQO_LOCAL_ACCESS", "true");
  vi.stubEnv("EQO_LOCAL_BIND", "127.0.0.1");
  vi.stubEnv("EQO_BFF_MODE", "terminal");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
}

function localRequest(overrides: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3000/api/readyz", {
    headers: {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3000",
      ...overrides,
    },
  });
}

describe("native readiness route", () => {
  it("reports local identity ready only for the configured loopback request boundary", async () => {
    setLocalEnvironment();

    const response = GET(localRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      identity_configured: true,
      runtime_mode: "terminal",
      runtime_profile_isolated: true,
      market_data: "not_checked",
      execution: "disabled",
    });

    const wrongHost = GET(localRequest({ host: "attacker.example" }));
    expect(wrongHost.status).toBe(503);
    expect(await wrongHost.json()).toMatchObject({
      status: "unavailable",
      identity_configured: false,
    });

    const forgedForwardedHost = GET(localRequest({ "x-forwarded-host": "attacker.example" }));
    expect(forgedForwardedHost.status).toBe(503);
    expect(await forgedForwardedHost.json()).toMatchObject({
      status: "unavailable",
      identity_configured: false,
    });
  });

  it("preserves OIDC readiness behavior", async () => {
    clearRuntimeEnvironment();
    vi.stubEnv("EQO_BFF_MODE", "terminal");
    vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
    vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
    vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret");
    vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
    vi.stubEnv("EQO_SESSION_TTL_SECONDS", "3600");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://terminal.example.test");
    vi.stubEnv("NEXTAUTH_URL", "https://terminal.example.test");

    const response = GET(new Request("https://terminal.example.test/api/readyz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      identity_configured: true,
      runtime_mode: "terminal",
    });
  });
});
