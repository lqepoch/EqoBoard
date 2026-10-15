import "server-only";

import { isRecord, hasExactKeys, OCC_PATTERN } from "./market-routes";

export type VerticalPreviewIntent = Readonly<{
  broker: "alpaca" | "ibkr" | "schwab";
  environment: "paper";
  kind: "vertical";
  symbol: null;
  quantity: number;
  limit_price: number;
  net_effect: "debit" | "credit";
  legs: readonly [
    Readonly<{ symbol: string; side: "buy" | "sell" }>,
    Readonly<{ symbol: string; side: "buy" | "sell" }>,
  ];
}>;

export type OrderIntentParseResult =
  | Readonly<{ ok: true; value: VerticalPreviewIntent }>
  | Readonly<{ ok: false; error: "invalid_order_intent" }>;

type ParsedLeg = Readonly<{
  symbol: string;
  side: "buy" | "sell";
  root: string;
  expiration: string;
  right: "C" | "P";
  strikeMillis: number;
}>;

function parseOccLeg(value: unknown): ParsedLeg | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["symbol", "side"]) ||
    typeof value.symbol !== "string" ||
    !OCC_PATTERN.test(value.symbol) ||
    (value.side !== "buy" && value.side !== "sell")
  )
    return null;
  const symbol = value.symbol;
  const root = symbol.slice(0, -15);
  const expirationText = symbol.slice(-15, -9);
  const right = symbol.slice(-9, -8);
  const strikeText = symbol.slice(-8);
  if (
    !/^[A-Z]{1,6}$/u.test(root) ||
    !/^\d{6}$/u.test(expirationText) ||
    !/^[CP]$/u.test(right) ||
    !/^\d{8}$/u.test(strikeText)
  )
    return null;
  const year = 2000 + Number(expirationText.slice(0, 2));
  const month = Number(expirationText.slice(2, 4));
  const day = Number(expirationText.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  const expiration = date.toISOString().slice(0, 10);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    expiration <= new Date().toISOString().slice(0, 10)
  )
    return null;
  const strikeMillis = Number(strikeText);
  if (!Number.isSafeInteger(strikeMillis) || strikeMillis <= 0) return null;
  return { symbol, side: value.side, root, expiration, right: right as "C" | "P", strikeMillis };
}

function positiveCentPrice(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000)
    return false;
  return /^\d+(?:\.\d{1,2})?$/u.test(value.toString());
}

export function parseVerticalPreviewIntent(value: unknown): OrderIntentParseResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "broker",
      "environment",
      "kind",
      "symbol",
      "quantity",
      "limit_price",
      "net_effect",
      "legs",
    ]) ||
    !["alpaca", "ibkr", "schwab"].includes(String(value.broker)) ||
    value.environment !== "paper" ||
    value.kind !== "vertical" ||
    value.symbol !== null ||
    typeof value.quantity !== "number" ||
    !Number.isSafeInteger(value.quantity) ||
    value.quantity < 1 ||
    value.quantity > 0xffff_ffff ||
    !positiveCentPrice(value.limit_price) ||
    (value.net_effect !== "debit" && value.net_effect !== "credit") ||
    !Array.isArray(value.legs) ||
    value.legs.length !== 2
  ) {
    return { ok: false, error: "invalid_order_intent" };
  }
  const first = parseOccLeg(value.legs[0]);
  const second = parseOccLeg(value.legs[1]);
  if (
    !first ||
    !second ||
    first.side === second.side ||
    first.symbol === second.symbol ||
    first.root !== second.root ||
    first.expiration !== second.expiration ||
    first.right !== second.right
  ) {
    return { ok: false, error: "invalid_order_intent" };
  }
  const buy = first.side === "buy" ? first : second;
  const sell = first.side === "sell" ? first : second;
  const inferredEffect =
    buy.right === "C"
      ? buy.strikeMillis < sell.strikeMillis
        ? "debit"
        : "credit"
      : buy.strikeMillis > sell.strikeMillis
        ? "debit"
        : "credit";
  const spreadWidthMillis = Math.abs(buy.strikeMillis - sell.strikeMillis);
  const limitPriceMillis = Math.round(value.limit_price * 1_000);
  if (
    value.net_effect !== inferredEffect ||
    !Number.isSafeInteger(limitPriceMillis) ||
    limitPriceMillis <= 0 ||
    limitPriceMillis >= spreadWidthMillis
  ) {
    return { ok: false, error: "invalid_order_intent" };
  }
  const legs: VerticalPreviewIntent["legs"] = [
    { symbol: first.symbol, side: first.side },
    { symbol: second.symbol, side: second.side },
  ];
  return {
    ok: true,
    value: {
      broker: value.broker as VerticalPreviewIntent["broker"],
      environment: "paper",
      kind: "vertical",
      symbol: null,
      quantity: value.quantity,
      limit_price: value.limit_price,
      net_effect: value.net_effect,
      legs,
    },
  };
}

export function isLockedVerticalPreview(value: unknown, expected: VerticalPreviewIntent): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["preview_id", "expires_at", "estimated_max_loss", "currency", "intent"])
  )
    return false;
  if (
    typeof value.preview_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.preview_id,
    ) ||
    typeof value.expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    typeof value.estimated_max_loss !== "number" ||
    !Number.isFinite(value.estimated_max_loss) ||
    value.estimated_max_loss <= 0 ||
    value.estimated_max_loss > Number.MAX_SAFE_INTEGER ||
    value.currency !== "USD"
  )
    return false;
  const parsed = parseVerticalPreviewIntent(value.intent);
  return parsed.ok && JSON.stringify(parsed.value) === JSON.stringify(expected);
}

export function isOrderPreviewResponse(value: unknown, expected: VerticalPreviewIntent): boolean {
  return (
    isRecord(value) &&
    value.execution_enabled === false &&
    isLockedVerticalPreview(value.preview, expected)
  );
}
