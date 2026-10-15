import { beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeRequest } from "@/lib/server/bff-security";
import { consumePrincipalRateLimit } from "@/lib/server/rate-limit";
import { authorizeMarketDelegation } from "@/lib/server/research/gateway";
import { loadMacro } from "@/lib/server/research/macro";
import { loadNews } from "@/lib/server/research/news";
import { clearResearchCacheForTests } from "@/lib/server/research/cache";
import { requireRuntimeMode } from "@/lib/server/runtime-mode";
import { GET } from "./route";

vi.mock("@/lib/server/bff-security", () => ({ authorizeRequest: vi.fn() }));
vi.mock("@/lib/server/rate-limit", () => ({ consumePrincipalRateLimit: vi.fn() }));
vi.mock("@/lib/server/runtime-mode", () => ({ requireRuntimeMode: vi.fn() }));
vi.mock("@/lib/server/research/gateway", () => ({
  authorizeMarketDelegation: vi.fn(),
  readSipSnapshotsWithDelegation: vi.fn(),
  readSipDailyBarsWithDelegation: vi.fn(),
}));
vi.mock("@/lib/server/research/news", () => ({ loadNews: vi.fn() }));
vi.mock("@/lib/server/research/macro", () => ({ loadMacro: vi.fn() }));

const principal = Object.freeze({
  identityIssuer: "https://identity.example",
  subject: "test-user",
  permissions: ["research:read"],
  sessionExpiresAt: Date.now() + 60_000,
});

function routeRequest(operation: string, query = ""): Request {
  return new Request(`https://research.example/api/research/data/${operation}${query}`);
}

function context(operation: string) {
  return { params: Promise.resolve({ operation }) } as const;
}

beforeEach(() => {
  vi.resetAllMocks();
  clearResearchCacheForTests();
  vi.mocked(requireRuntimeMode).mockReturnValue(null);
  vi.mocked(consumePrincipalRateLimit).mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("closed native research data route", () => {
  it("hides the terminal-only provider route before authorization in Research mode", async () => {
    vi.mocked(requireRuntimeMode).mockReturnValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }) as never);
    const response = await GET(routeRequest("news"), context("news"));

    expect(response.status).toBe(404);
    expect(requireRuntimeMode).toHaveBeenCalledWith("terminal", expect.any(Request));
    expect(authorizeRequest).not.toHaveBeenCalled();
    expect(loadNews).not.toHaveBeenCalled();
  });

  it("rejects unknown operations before authorization or provider dispatch", async () => {
    const response = await GET(routeRequest("arbitrary"), context("arbitrary"));

    expect(response.status).toBe(404);
    expect(authorizeRequest).not.toHaveBeenCalled();
    expect(loadNews).not.toHaveBeenCalled();
  });

  it("rechecks research:read before any provider request", async () => {
    vi.mocked(authorizeRequest).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) as never,
    });

    const response = await GET(routeRequest("news"), context("news"));

    expect(response.status).toBe(403);
    expect(consumePrincipalRateLimit).not.toHaveBeenCalled();
    expect(loadNews).not.toHaveBeenCalled();
  });

  it("requires both research and market delegation before macro/SIP provider reads", async () => {
    vi.mocked(authorizeRequest).mockResolvedValue({ ok: true, principal } as never);
    vi.mocked(authorizeMarketDelegation).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) as never,
    } as never);

    const response = await GET(routeRequest("macro", "?region=us"), context("macro"));

    expect(response.status).toBe(403);
    expect(authorizeMarketDelegation).toHaveBeenCalledWith(principal);
    expect(loadMacro).not.toHaveBeenCalled();
  });

  it("returns provider evidence and no-store cache headers for a valid read", async () => {
    vi.mocked(authorizeRequest).mockResolvedValue({ ok: true, principal } as never);
    vi.mocked(loadNews).mockResolvedValue({
      source: {
        provider: "Google News RSS",
        providerUrl: "https://news.google.com/",
        sourcePath: "apps/openterminal/server/src/providers/news.ts",
        license: null,
      },
      data: [],
      asOf: null,
      complete: false,
      failedItems: 1,
      truncated: false,
      warning: "Provider rights are unknown.",
    });

    const response = await GET(routeRequest("news"), context("news"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      schemaVersion: 1,
      operation: "news",
      source: { provider: "Google News RSS", license: null },
      status: "partial",
      asOf: null,
      completeness: { complete: false, failedItems: 1 },
    });
  });
});
