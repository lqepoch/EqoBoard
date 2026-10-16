import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const securityMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  signGatewayDelegation: vi.fn(),
  signMdpMarketReadDelegation: vi.fn(),
}));
const coreBarsMocks = vi.hoisted(() => ({ coreBarsRateLimit: vi.fn(() => true) }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/bff-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/bff-security")>();
  return { ...actual, ...securityMocks };
});
vi.mock("@/lib/server/core-bars", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/core-bars")>();
  return { ...actual, ...coreBarsMocks };
});

import { NextRequest } from "next/server";

const { GET } = await import("./route");

const localPrincipal = {
  identityIssuer: "http://127.0.0.1:3000/local-workstation",
  subject: "local-workstation",
  permissions: ["market:read"],
  sessionExpiresAt: Date.now() + 120_000,
};

function setLocalEnvironment(): void {
  vi.stubEnv("EQO_LOCAL_ACCESS", "true");
  vi.stubEnv("EQO_LOCAL_CORE_BARS", "true");
  vi.stubEnv("EQO_LOCAL_BIND", "127.0.0.1");
  vi.stubEnv("EQO_BFF_MODE", "terminal");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
}

function request(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/history/SPY", {
    headers: { host: "127.0.0.1:3000" },
  });
}

const context = { params: Promise.resolve({ symbol: "SPY" }) };

beforeEach(() => {
  setLocalEnvironment();
  securityMocks.authorizeRequest.mockResolvedValue({ ok: true, principal: localPrincipal });
  securityMocks.signGatewayDelegation.mockResolvedValue({
    ok: true,
    principal: localPrincipal,
    token: "gateway-token",
    expiresAt: Date.now() + 60_000,
  });
  securityMocks.signMdpMarketReadDelegation.mockResolvedValue({
    ok: true,
    principal: localPrincipal,
    token: "mdp-token",
    expiresAt: Date.now() + 60_000,
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  securityMocks.authorizeRequest.mockReset();
  securityMocks.signGatewayDelegation.mockReset();
  securityMocks.signMdpMarketReadDelegation.mockReset();
  coreBarsMocks.coreBarsRateLimit.mockClear();
});

describe("Core Bars history route local upstream boundary", () => {
  it("does not sign or fetch when local Core Bars is disabled or the URL is not exact", async () => {
    vi.stubEnv("EQO_MDP_URL", "http://127.0.0.1:8088");
    vi.stubEnv("EQO_LOCAL_CORE_BARS", "false");
    const disabled = await GET(request(), context);
    expect(disabled.status).toBe(503);
    expect(securityMocks.signMdpMarketReadDelegation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    vi.stubEnv("EQO_LOCAL_CORE_BARS", "true");
    for (const value of ["https://attacker.example", "http://127.0.0.1:8089"]) {
      vi.stubEnv("EQO_MDP_URL", value);
      const rejected = await GET(request(), context);
      expect(rejected.status, value).toBe(503);
    }
    expect(securityMocks.signMdpMarketReadDelegation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses separate short-lived Gateway and MDP tokens for the exact local MDP origin", async () => {
    vi.stubEnv("EQO_MDP_URL", "http://127.0.0.1:8088");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const upstreamRequest = new Request(input, init);
        expect(new URL(upstreamRequest.url).origin).toBe("http://127.0.0.1:8088");
        expect(upstreamRequest.headers.get("authorization")).toBe("Bearer mdp-token");
        expect(upstreamRequest.headers.get("x-eqo-gateway-delegation")).toBe("gateway-token");
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(securityMocks.signMdpMarketReadDelegation).toHaveBeenCalledWith(localPrincipal);
    expect(securityMocks.signGatewayDelegation).toHaveBeenCalledWith(
      localPrincipal,
      "market:read",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
