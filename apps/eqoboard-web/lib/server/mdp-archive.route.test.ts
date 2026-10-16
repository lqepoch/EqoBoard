import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const securityMocks = vi.hoisted(() => ({ authorizeRequest: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("./bff-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bff-security")>();
  return { ...actual, authorizeRequest: securityMocks.authorizeRequest };
});

import { NextRequest } from "next/server";

const { proxyMdpBars } = await import("./mdp-archive");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  securityMocks.authorizeRequest.mockReset();
});

describe("diagnostic archive signer availability", () => {
  beforeEach(() => {
    vi.stubEnv("EQO_BFF_MODE", "research");
    vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
    vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
    vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret-not-a-signer");
    vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://research.example.test");
    vi.stubEnv("NEXTAUTH_URL", "https://research.example.test");
    vi.stubEnv("EQO_MDP_URL", "http://market-data-platform:4452");
    for (const name of [
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
      "EQO_OPENBB_OIDC_CLIENT_SECRET",
    ])
      vi.stubEnv(name, "");
    securityMocks.authorizeRequest.mockResolvedValue({
      ok: true,
      principal: {
        identityIssuer: "https://id.example.test/native",
        subject: "reader-1",
        permissions: ["market:read"],
        sessionExpiresAt: Date.now() + 60_000,
      },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns unavailable without contacting MDP when the runtime has no MDP signer key", async () => {
    const request = new NextRequest(
      "https://research.example.test/api/eqo/market-data/datasets/archive-1/bars?namespace=diagnostic&symbol=QQQ",
    );
    const response = await proxyMdpBars(request, "archive-1");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "identity_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
