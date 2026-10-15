import { describe, expect, it } from "vitest";
import type { Permission } from "../../lib/contracts/auth";
import {
  buildNativeActionRequest,
  buildNativeReadRequest,
  isNativeDataOperationId,
  NATIVE_OPERATION_PERMISSION,
} from "../../features/data/operations";
import type { NativeDataOperationId } from "../../features/data/operations";

const YAHOO_INPUT = {
  symbol: "SPY",
  assetClass: "stock",
  startUtc: "2026-01-01T00:00:00.000Z",
  endUtc: "2026-01-02T00:00:00.000Z",
  adjustment: "adjusted",
} as const;

const EXPECTED_READ_OPERATIONS: Readonly<Record<NativeDataOperationId, Readonly<{
  permission: Permission;
  path: string;
}>>> = Object.freeze({
  "market.quotes": { permission: "market:read", path: "/api/quotes?symbols=SPY%2CQQQ" },
  "market.options.chain": { permission: "market:read", path: "/api/options/SPY?expiry=2026-10-16" },
  "market.status": { permission: "market:read", path: "/api/status" },
  "market.history.core-bars": { permission: "market:read", path: "/api/history/SPY" },
  "market.archive.diagnostic-bars": {
    permission: "market:read",
    path: "/api/eqo/market-data/datasets/fixture-1/bars?namespace=diagnostic&symbol=SPY",
  },
  "research.yahoo.daily": {
    permission: "research:read",
    path: "/api/research/yfinance/daily?symbols=SPY&asset_class=stock&start_utc=2026-01-01T00%3A00%3A00.000Z&end_utc=2026-01-02T00%3A00%3A00.000Z&adjustment=adjusted",
  },
  "research.predictions": {
    permission: "research:private-read",
    path: "/api/eqo/research/predictions/run-2026-10-15",
  },
  "engine.status": { permission: "engine:offline-read", path: "/api/eqo/engine/status" },
  "engine.preview": { permission: "engine:offline-read", path: "/api/eqo/engine/preview" },
  "research.news": { permission: "research:read", path: "/api/research/data/news?symbol=SPY" },
  "research.macro": { permission: "research:read", path: "/api/research/data/macro?region=us" },
  "research.economicCalendar": { permission: "research:read", path: "/api/research/data/economic-calendar" },
  "research.earningsCalendar": {
    permission: "research:read",
    path: "/api/research/data/earnings-calendar?symbols=SPY%2CQQQ",
  },
  "research.earningsHistory": { permission: "research:read", path: "/api/research/data/earnings-history?symbol=SPY" },
  "research.insider": { permission: "research:read", path: "/api/research/data/insider?symbol=SPY" },
  "research.screener": { permission: "research:read", path: "/api/research/data/screener?market=us&limit=25" },
  "research.heatmap": { permission: "research:read", path: "/api/research/data/heatmap?market=us" },
  "research.crypto": { permission: "research:read", path: "/api/research/data/crypto" },
  "research.cryptoGlobal": { permission: "research:read", path: "/api/research/data/crypto-global" },
  "portfolio.list": { permission: "workspace:read", path: "/api/portfolios" },
  "portfolio.positions": { permission: "workspace:read", path: "/api/portfolios/1/positions" },
  "portfolio.transactions": { permission: "workspace:read", path: "/api/portfolios/1/transactions" },
});

const INPUTS: Record<NativeDataOperationId, unknown> = {
  "market.quotes": { symbols: ["SPY", "QQQ"] },
  "market.options.chain": { symbol: "SPY", expiry: "2026-10-16" },
  "market.status": {},
  "market.history.core-bars": { symbol: "SPY" },
  "market.archive.diagnostic-bars": { datasetId: "fixture-1", symbol: "SPY" },
  "research.yahoo.daily": YAHOO_INPUT,
  "research.predictions": { runId: "run-2026-10-15" },
  "engine.status": {},
  "engine.preview": {},
  "research.news": { symbol: "SPY" },
  "research.macro": { region: "us" },
  "research.economicCalendar": {},
  "research.earningsCalendar": { symbols: ["SPY", "QQQ"] },
  "research.earningsHistory": { symbol: "SPY" },
  "research.insider": { symbol: "SPY" },
  "research.screener": { market: "us", limit: 25 },
  "research.heatmap": { market: "us" },
  "research.crypto": {},
  "research.cryptoGlobal": {},
  "portfolio.list": {},
  "portfolio.positions": { portfolioId: 1 },
  "portfolio.transactions": { portfolioId: 1 },
};

const VALID_VERTICAL_PREVIEW = Object.freeze({
  broker: "alpaca",
  environment: "paper",
  kind: "vertical",
  symbol: null,
  quantity: 1,
  limit_price: 1.25,
  net_effect: "debit",
  legs: [
    { symbol: "SPY261016C00500000", side: "buy" },
    { symbol: "SPY261016C00510000", side: "sell" },
  ],
});

describe("native browser operation and action boundaries", () => {
  it("pins every native read ID, exact same-origin path, and required permission", () => {
    expect(Object.keys(NATIVE_OPERATION_PERMISSION).sort()).toEqual(Object.keys(EXPECTED_READ_OPERATIONS).sort());

    for (const [rawId, expected] of Object.entries(EXPECTED_READ_OPERATIONS)) {
      const operationId = rawId as NativeDataOperationId;
      expect(isNativeDataOperationId(rawId)).toBe(true);
      expect(NATIVE_OPERATION_PERMISSION[operationId]).toBe(expected.permission);
      const request = buildNativeReadRequest(operationId, INPUTS[operationId] as never);
      expect(request, operationId).toEqual({
        method: "GET",
        path: expected.path,
        permission: expected.permission,
      });
      expect(new URL(request!.path, "https://terminal.invalid").origin).toBe("https://terminal.invalid");
    }
  });

  it("does not expose submit, broker, or arbitrary path read operation IDs", () => {
    for (const value of ["orders.submit", "broker.submit", "market.orders.submit", "../../api/admin"]) {
      expect(isNativeDataOperationId(value)).toBe(false);
    }
  });

  it("rejects caller-supplied URLs, methods, headers, duplicate symbols, and invalid dates", () => {
    expect(buildNativeReadRequest("market.quotes", {
      symbols: ["SPY"],
      url: "https://broker.invalid/orders",
      method: "POST",
      headers: { Authorization: "sentinel" },
    } as never)).toBeNull();
    expect(buildNativeReadRequest("market.history.core-bars", {
      symbol: "SPY",
      path: "/api/v1/orders/submit",
    } as never)).toBeNull();
    expect(buildNativeReadRequest("market.quotes", { symbols: ["SPY", "SPY"] })).toBeNull();
    expect(buildNativeReadRequest("market.options.chain", { symbol: "SPY", expiry: "2026-02-30" })).toBeNull();
    expect(buildNativeReadRequest("research.yahoo.daily", { ...YAHOO_INPUT, cursor: "\u0000" })).toBeNull();
  });

  it("compiles only the explicit AI, manual-ledger, and vertical-preview actions", () => {
    expect(buildNativeActionRequest("research.ai", {
      messages: [{ role: "user", content: "Summarize this supplied note." }],
    })).toEqual({
      method: "POST",
      path: "/api/research/ai",
      permission: "research:ai",
      body: { messages: [{ role: "user", content: "Summarize this supplied note." }] },
    });
    expect(buildNativeActionRequest("portfolio.create", { name: "Long term" })).toEqual({
      method: "POST", path: "/api/portfolios", permission: "workspace:write", body: { name: "Long term" },
    });
    expect(buildNativeActionRequest("portfolio.delete", { portfolioId: 2 })).toEqual({
      method: "DELETE", path: "/api/portfolios/2", permission: "workspace:write",
    });
    expect(buildNativeActionRequest("portfolio.transaction.create", {
      portfolioId: 2,
      symbol: "SPY",
      side: "BUY",
      quantity: 1,
      price: 500,
      executed_at: "2026-10-15T12:00:00.000Z",
    })).toEqual({
      method: "POST",
      path: "/api/portfolios/2/transactions",
      permission: "workspace:write",
      body: { symbol: "SPY", side: "BUY", quantity: 1, price: 500, executed_at: "2026-10-15T12:00:00.000Z" },
    });
    expect(buildNativeActionRequest("portfolio.transaction.delete", { portfolioId: 2, transactionId: 9 })).toEqual({
      method: "DELETE", path: "/api/portfolios/2/transactions/9", permission: "workspace:write",
    });
    expect(buildNativeActionRequest("orders.preview.vertical", VALID_VERTICAL_PREVIEW)).toEqual({
      method: "POST",
      path: "/api/eqo/orders/preview",
      permission: "orders:preview",
      body: VALID_VERTICAL_PREVIEW,
    });
  });

  it("rejects unknown and submit-like runtime action IDs even with a valid preview-shaped payload", () => {
    for (const value of ["orders.submit", "broker.submit", "paper.submit", "market.orders.submit"]) {
      expect(buildNativeActionRequest(value as never, VALID_VERTICAL_PREVIEW)).toBeNull();
    }
    expect(buildNativeActionRequest("orders.preview.vertical", { ...VALID_VERTICAL_PREVIEW, url: "https://broker.invalid" })).toBeNull();
    expect(buildNativeActionRequest("research.ai", { prompt: "test" })).toBeNull();
  });
});
