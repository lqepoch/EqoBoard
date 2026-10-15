import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const authMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  authorizeGatewayRequest: vi.fn(),
  signGatewayDelegation: vi.fn(),
  signMdpMarketReadDelegation: vi.fn(),
  signMdpResearchReadDelegation: vi.fn(),
  signEngineOfflineReadDelegation: vi.fn(),
  signQuantPredictionReadDelegation: vi.fn(),
  noStoreJson: vi.fn(),
  readBoundedJson: vi.fn(),
  jsonError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/bff-security", () => authMocks);

import { GET as quotesGet } from "../../app/api/quotes/route";
import { GET as optionsGet } from "../../app/api/options/[symbol]/route";
import { GET as historyGet } from "../../app/api/history/[symbol]/route";
import { GET as researchDataGet } from "../../app/api/research/data/[operation]/route";
import { getYfinanceDaily } from "../../lib/server/yfinance-daily";
import { POST as researchAiPost } from "../../app/api/research/ai/route";
import { POST as orderPreviewPost } from "../../app/api/eqo/orders/preview/route";
import { GET as liveGet } from "../../app/api/eqo/live/route";
import { GET as engineStatusGet } from "../../app/api/eqo/engine/status/route";
import { GET as enginePreviewGet } from "../../app/api/eqo/engine/preview/route";
import { GET as predictionGet } from "../../app/api/eqo/research/predictions/[runId]/route";

const origin = "https://native.invalid";

function nextRequest(path: string, method = "GET", body?: string): NextRequest {
  return new NextRequest(new URL(path, origin), {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json", origin },
      body,
    }),
  });
}

function researchRuntime(): void {
  // Pin only the CI/test research profile so the real mode guard reaches the
  // authorization boundary. Clear opposite-profile secrets/credentials even
  // if the test runner inherits unrelated environment values.
  for (const name of [
    "EQO_GATEWAY_JWT_SECRET",
    "MDP_TERMINAL_JWT_SECRET",
    "QUANT_TERMINAL_JWT_SECRET",
    "ENGINE_TERMINAL_JWT_SECRET",
    "ALPACA_KEY",
    "ALPACA_SECRET",
    "EQO_ADAPTER_ALPACA_TOKEN",
    "EQO_ADAPTER_IBKR_TOKEN",
    "EQO_ADAPTER_SCHWAB_TOKEN",
    "ANTHROPIC_API_KEY",
    "EQO_RESEARCH_JWT_SECRET",
    "QUANT_RESEARCH_JWT_SECRET",
    "ENGINE_RESEARCH_JWT_SECRET",
    "EQO_RESEARCH_API_KEY",
    "NEXTAUTH_SECRET",
    "EQO_OIDC_CLIENT_SECRET",
    "EQO_OPENBB_OIDC_CLIENT_SECRET",
  ]) vi.stubEnv(name, "");
  vi.stubEnv("EQO_BFF_MODE", "research");
  vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
}

async function expectDenied(result: Response): Promise<void> {
  expect(result.status).toBe(403);
  expect(await result.json()).toEqual({ error: "forbidden" });
}

describe("protected native route dispatch boundary", () => {
  const downstreamFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", downstreamFetch);
    downstreamFetch.mockImplementation(async () => {
      throw new Error("protected route attempted downstream network access after missing permission");
    });
    const forbidden = { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    authMocks.authorizeRequest.mockResolvedValue(forbidden);
    authMocks.authorizeGatewayRequest.mockResolvedValue(forbidden);
    authMocks.signGatewayDelegation.mockResolvedValue(forbidden);
    authMocks.signMdpMarketReadDelegation.mockResolvedValue(forbidden);
    authMocks.signMdpResearchReadDelegation.mockResolvedValue(forbidden);
    authMocks.signEngineOfflineReadDelegation.mockResolvedValue(forbidden);
    authMocks.signQuantPredictionReadDelegation.mockResolvedValue(forbidden);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns the missing-scope response before Gateway, MDP, Quant, Engine, or AI provider dispatch", async () => {
    const cases: ReadonlyArray<Readonly<{ name: string; invoke: () => Promise<Response>; usesGatewayAuthorization?: boolean }>> = [
      { name: "quote snapshots", invoke: () => quotesGet(nextRequest("/api/quotes?symbols=SPY")), usesGatewayAuthorization: true },
      { name: "option chain", invoke: () => optionsGet(nextRequest("/api/options/SPY?expiry=2026-10-16"), { params: Promise.resolve({ symbol: "SPY" }) }), usesGatewayAuthorization: true },
      { name: "Core Bars/MDP", invoke: () => historyGet(nextRequest("/api/history/SPY?range=1D"), { params: Promise.resolve({ symbol: "SPY" }) }) },
      { name: "research data", invoke: () => researchDataGet(nextRequest("/api/research/data/news?symbol=SPY"), { params: Promise.resolve({ operation: "news" }) }) },
      { name: "research AI", invoke: () => researchAiPost(nextRequest("/api/research/ai", "POST", JSON.stringify({ messages: [{ role: "user", content: "must remain local" }] }))) },
      { name: "order preview", invoke: () => orderPreviewPost(nextRequest("/api/eqo/orders/preview", "POST", "{}")), usesGatewayAuthorization: true },
      { name: "market stream", invoke: () => liveGet(nextRequest("/api/eqo/live")) },
      { name: "Engine status", invoke: () => engineStatusGet(nextRequest("/api/eqo/engine/status")) },
      { name: "Engine preview", invoke: () => enginePreviewGet(nextRequest("/api/eqo/engine/preview")) },
      { name: "private prediction", invoke: () => predictionGet(nextRequest("/api/eqo/research/predictions/run-acceptance"), { params: Promise.resolve({ runId: "run-acceptance" }) }) },
    ];

    for (const route of cases) {
      authMocks.authorizeRequest.mockClear();
      authMocks.authorizeGatewayRequest.mockClear();
      await expectDenied(await route.invoke());
      if (route.usesGatewayAuthorization) {
        expect(authMocks.authorizeGatewayRequest, route.name).toHaveBeenCalled();
      } else {
        expect(authMocks.authorizeRequest, route.name).toHaveBeenCalled();
      }
      expect(downstreamFetch, route.name).not.toHaveBeenCalled();
    }

    expect(authMocks.signGatewayDelegation).not.toHaveBeenCalled();
    expect(authMocks.signMdpMarketReadDelegation).not.toHaveBeenCalled();
    expect(authMocks.signMdpResearchReadDelegation).not.toHaveBeenCalled();
    expect(authMocks.signEngineOfflineReadDelegation).not.toHaveBeenCalled();
    expect(authMocks.signQuantPredictionReadDelegation).not.toHaveBeenCalled();
  });

  it("denies a Research Yahoo request before MDP dispatch when research:read is missing", async () => {
    researchRuntime();
    authMocks.authorizeRequest.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    await expectDenied(await getYfinanceDaily(nextRequest(
      "/api/research/yfinance/daily?symbols=SPY&asset_class=stock&start_utc=2026-01-01T00%3A00%3A00.000Z&end_utc=2026-01-02T00%3A00%3A00.000Z&adjustment=adjusted",
    )));
    expect(authMocks.authorizeRequest).toHaveBeenCalledWith(expect.anything(), "research:read");
    expect(authMocks.signMdpResearchReadDelegation).not.toHaveBeenCalled();
    expect(downstreamFetch).not.toHaveBeenCalled();
  });

  it("does not call MDP when the separate research signer is unavailable", async () => {
    researchRuntime();
    vi.stubEnv("EQO_MDP_URL", "http://market-data-platform:4452");
    authMocks.authorizeRequest.mockResolvedValue({
      ok: true,
      principal: {
        identityIssuer: "https://issuer.invalid",
        subject: "unit-test-principal",
        permissions: ["research:read"],
        sessionExpiresAt: Date.now() + 60_000,
      },
    });
    authMocks.signMdpResearchReadDelegation.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "identity_unavailable" }, { status: 503 }),
    });

    const response = await getYfinanceDaily(nextRequest(
      "/api/research/yfinance/daily?symbols=SPY&asset_class=stock&start_utc=2026-01-01T00%3A00%3A00.000Z&end_utc=2026-01-02T00%3A00%3A00.000Z&adjustment=adjusted",
    ));

    expect(response.status).toBe(503);
    expect(authMocks.signMdpResearchReadDelegation).toHaveBeenCalledTimes(1);
    expect(downstreamFetch).not.toHaveBeenCalled();
  });
});
