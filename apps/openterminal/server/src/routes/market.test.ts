import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createMarketRouter, marketRouter } from "./market.js";

function fakeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function getHandler(path: string) {
  const layer = (marketRouter as any).stack.find((l: any) => l.route?.path === path);
  if (!layer) throw new Error(`no route registered for ${path}`);
  return layer.route.stack.at(-1).handle as (req: Request, res: Response, next: () => void) => unknown;
}

describe("market router factory", () => {
  it("uses the complete production route set when constructing isolated limiters", () => {
    const routePaths = (router: unknown) => (router as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => layer.route.path);

    expect(routePaths(createMarketRouter({ ownerLimit: 2, serviceLimit: 3 }))).toEqual(routePaths(marketRouter));
  });
});

describe("GET /crypto/orderbook/:symbol", () => {
  it("rejects a symbol outside the supported crypto whitelist with 400, before touching the network", async () => {
    const handler = getHandler("/crypto/orderbook/:symbol");
    const req = { params: { symbol: "AAA&limit=5000" } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "unsupported crypto symbol" });
  });

  it("accepts a whitelisted symbol (case-insensitive) and proceeds past validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ bids: [], asks: [] }) })
    );
    try {
      const handler = getHandler("/crypto/orderbook/:symbol");
      const req = { params: { symbol: "btc" } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => {});

      expect(res.status).not.toHaveBeenCalledWith(400);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
