import type { VerticalPreviewIntent } from "../data/operations";
import { hasControlCharacters, hasOnlyEnumerableDataProperties } from "../data/validation";

const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const OCC = /^([A-Z0-9.]{1,10})(\d{6})([CP])(\d{8})$/u;

export type MarketSourceEvidence = Readonly<{
  source: string | null;
  sourceMode: string | null;
  sourceLabel: string | null;
  sourceEntitlement: string | null;
  feed: string | null;
  asOf: string | null;
}>;

export type StockSnapshotRow = Readonly<{
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  changePercent: number | null;
  volume: number | null;
  quoteAt: string | null;
  tradeAt: string | null;
  marketAsOf: string | null;
  wire: Readonly<Record<string, unknown>>;
}>;

export type QuoteResponse =
  | Readonly<{
      status: "available";
      evidence: MarketSourceEvidence;
      snapshots: readonly StockSnapshotRow[];
      wire: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      status: "unsupported-source";
      evidence: MarketSourceEvidence;
      wire: Readonly<Record<string, unknown>>;
    }>;

export type OptionContractRow = Readonly<{
  symbol: string;
  underlying: string;
  expiration: string;
  right: "call" | "put";
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  bidSize: number | null;
  askSize: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  quoteAt: string | null;
  tradeAt: string | null;
  modelAsOf: string | null;
  feed: string;
  wire: Readonly<Record<string, unknown>>;
}>;

export type OptionChainResponse = Readonly<{
  underlying: string;
  expiration: string;
  feed: string;
  source: "alpaca";
  asOf: string | null;
  truncated: boolean;
  contracts: readonly OptionContractRow[];
  wire: Readonly<Record<string, unknown>>;
}>;

export type VerticalPreviewReceipt = Readonly<{
  executionEnabled: false;
  preview: Readonly<{
    previewId: string;
    expiresAt: string;
    estimatedMaxLoss: number;
    currency: string;
    intent: VerticalPreviewIntent;
  }>;
  wire: Readonly<Record<string, unknown>>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (!hasOnlyEnumerableDataProperties(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function string(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    !hasControlCharacters(value)
  );
}

function nullableString(value: unknown, max = 256): value is string | null {
  return value === null || string(value, max);
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function optionalNullableFinite(row: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(row, key) || nullableFinite(row[key]);
}

function optionalNullableString(row: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(row, key) || nullableString(row[key], 128);
}

function evidence(
  row: Record<string, unknown>,
  sourceDefault: string | null = null,
): MarketSourceEvidence {
  const source =
    typeof row.source === "string" && string(row.source, 64) ? row.source : sourceDefault;
  const sourceMode =
    typeof row.source_mode === "string" && string(row.source_mode, 64) ? row.source_mode : null;
  const sourceLabel =
    typeof row.source_label === "string" && string(row.source_label, 128) ? row.source_label : null;
  const sourceEntitlement =
    typeof row.source_entitlement === "string" && string(row.source_entitlement, 64)
      ? row.source_entitlement
      : null;
  const feed = typeof row.feed === "string" && string(row.feed, 64) ? row.feed : null;
  // Receipt time describes the Gateway hop, not when the market observation
  // occurred. Keep it in the raw wire envelope instead of promoting it to asOf.
  const rawAsOf = row.as_of ?? row.market_as_of ?? null;
  const asOf = nullableString(rawAsOf, 128) ? rawAsOf : null;
  return Object.freeze({ source, sourceMode, sourceLabel, sourceEntitlement, feed, asOf });
}

function parseSnapshot(value: unknown): StockSnapshotRow | null {
  const row = record(value);
  if (!row || !string(row.symbol, 16) || !TICKER.test(row.symbol)) return null;
  for (const key of [
    "last",
    "bid",
    "ask",
    "open",
    "high",
    "low",
    "previous_close",
    "change_percent",
    "volume",
  ]) {
    if (!optionalNullableFinite(row, key)) return null;
  }
  for (const key of ["quote_at", "trade_at", "market_as_of", "last_as_of", "updated_at"]) {
    if (!optionalNullableString(row, key)) return null;
  }
  const readNumber = (key: string): number | null => (nullableFinite(row[key]) ? row[key] : null);
  const readText = (...keys: string[]): string | null => {
    for (const key of keys)
      if (nullableString(row[key], 128) && row[key] !== null) return row[key] as string;
    return null;
  };
  return Object.freeze({
    symbol: row.symbol,
    last: readNumber("last"),
    bid: readNumber("bid"),
    ask: readNumber("ask"),
    open: readNumber("open"),
    high: readNumber("high"),
    low: readNumber("low"),
    previousClose: readNumber("previous_close"),
    changePercent: readNumber("change_percent"),
    volume: readNumber("volume"),
    quoteAt: readText("quote_at"),
    tradeAt: readText("trade_at", "updated_at"),
    marketAsOf: readText("market_as_of", "last_as_of"),
    wire: Object.freeze({ ...row }),
  });
}

function isKnownFutuSnapshotEnvelope(row: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(row, "source") &&
    row.source_mode === "futu" &&
    row.source_label === "Futu OpenD" &&
    row.source_entitlement === "unknown" &&
    row.feed === "futu"
  );
}

function hasFutuSnapshotEvidence(row: StockSnapshotRow): boolean {
  return (
    row.wire.source_mode === "futu" &&
    row.wire.source_label === "Futu OpenD" &&
    row.wire.feed === "futu"
  );
}

/** Accepts the current Alpaca and explicitly identified Futu Gateway snapshot variants. */
export function decodeQuoteResponse(value: unknown): QuoteResponse | null {
  const row = record(value);
  if (!row) return null;
  const isAlpaca = row.source === "alpaca";
  const isFutu = isKnownFutuSnapshotEnvelope(row);
  if (!isAlpaca && !isFutu) {
    return Object.freeze({
      status: "unsupported-source",
      evidence: evidence(row),
      wire: Object.freeze({ ...row }),
    });
  }
  if (
    !string(row.feed, 64) ||
    (isFutu
      ? Object.hasOwn(row, "as_of") && !nullableString(row.as_of, 128)
      : !nullableString(row.as_of, 128)) ||
    !Array.isArray(row.snapshots) ||
    row.snapshots.length > (isFutu ? 32 : 50)
  )
    return null;
  const snapshots: StockSnapshotRow[] = [];
  const seen = new Set<string>();
  for (const item of row.snapshots) {
    const parsed = parseSnapshot(item);
    if (!parsed || (isFutu && !hasFutuSnapshotEvidence(parsed)) || seen.has(parsed.symbol))
      return null;
    seen.add(parsed.symbol);
    snapshots.push(parsed);
  }
  const sourceEvidence = isFutu
    ? Object.freeze({ ...evidence(row, "futu"), source: "futu" })
    : evidence(row);
  return Object.freeze({
    status: "available",
    evidence: sourceEvidence,
    snapshots: Object.freeze(snapshots),
    wire: Object.freeze({ ...row }),
  });
}

export function parseOccContractSymbol(value: string): Readonly<{
  underlyingRoot: string;
  yymmdd: string;
  right: "call" | "put";
  strike: number;
}> | null {
  const match = OCC.exec(value);
  if (!match) return null;
  const underlyingRoot = match[1];
  const yymmdd = match[2];
  const rightCode = match[3];
  const strikeText = match[4];
  if (!underlyingRoot || !yymmdd || !rightCode || !strikeText) return null;
  const strikeUnits = Number(strikeText);
  if (!Number.isSafeInteger(strikeUnits)) return null;
  return Object.freeze({
    underlyingRoot,
    yymmdd,
    right: rightCode === "C" ? "call" : "put",
    strike: strikeUnits / 1_000,
  });
}

function parseOptionContract(
  value: unknown,
  underlying: string,
  expiration: string,
  feed: string,
): OptionContractRow | null {
  const row = record(value);
  if (
    !row ||
    !string(row.symbol, 32) ||
    !string(row.underlying, 16) ||
    row.underlying !== underlying ||
    row.expiration !== expiration ||
    (row.right !== "call" && row.right !== "put") ||
    typeof row.strike !== "number" ||
    !Number.isFinite(row.strike) ||
    row.strike < 0 ||
    row.feed !== feed
  )
    return null;
  const occ = parseOccContractSymbol(row.symbol);
  if (
    !occ ||
    occ.underlyingRoot !== underlying ||
    occ.yymmdd !== expiration.slice(2).replaceAll("-", "") ||
    occ.right !== row.right ||
    Math.round(occ.strike * 1_000) !== Math.round(row.strike * 1_000)
  )
    return null;
  const numberKeys = [
    "bid",
    "ask",
    "last",
    "bid_size",
    "ask_size",
    "iv",
    "delta",
    "gamma",
    "theta",
    "vega",
  ] as const;
  for (const key of numberKeys) if (!optionalNullableFinite(row, key)) return null;
  for (const key of ["updated_at", "quote_at", "trade_at", "model_as_of"])
    if (!optionalNullableString(row, key)) return null;
  const number = (key: (typeof numberKeys)[number]): number | null =>
    nullableFinite(row[key]) ? row[key] : null;
  const text = (key: string): string | null =>
    nullableString(row[key], 128) && row[key] !== null ? (row[key] as string) : null;
  return Object.freeze({
    symbol: row.symbol,
    underlying,
    expiration,
    right: row.right,
    strike: row.strike,
    bid: number("bid"),
    ask: number("ask"),
    last: number("last"),
    bidSize: number("bid_size"),
    askSize: number("ask_size"),
    iv: number("iv"),
    delta: number("delta"),
    gamma: number("gamma"),
    theta: number("theta"),
    vega: number("vega"),
    quoteAt: text("quote_at"),
    tradeAt: text("trade_at"),
    modelAsOf: text("model_as_of"),
    feed,
    wire: Object.freeze({ ...row }),
  });
}

/** Validates the Alpaca chain envelope and its contracts without relabeling feed/Greeks evidence. */
export function decodeOptionChainResponse(
  value: unknown,
  expectedUnderlying: string,
  expectedExpiration: string,
): OptionChainResponse | null {
  const row = record(value);
  if (
    row?.source !== "alpaca" ||
    row.underlying !== expectedUnderlying ||
    row.expiration !== expectedExpiration ||
    !string(row.feed, 64) ||
    !nullableString(row.as_of, 128) ||
    typeof row.truncated !== "boolean" ||
    !Array.isArray(row.contracts) ||
    row.contracts.length > 10_000
  )
    return null;
  const contracts: OptionContractRow[] = [];
  const seen = new Set<string>();
  for (const item of row.contracts) {
    const parsed = parseOptionContract(item, expectedUnderlying, expectedExpiration, row.feed);
    if (!parsed || seen.has(parsed.symbol)) return null;
    seen.add(parsed.symbol);
    contracts.push(parsed);
  }
  return Object.freeze({
    underlying: expectedUnderlying,
    expiration: expectedExpiration,
    feed: row.feed,
    source: "alpaca",
    asOf: row.as_of,
    truncated: row.truncated,
    contracts: Object.freeze(contracts),
    wire: Object.freeze({ ...row }),
  });
}

function previewIntent(value: unknown): VerticalPreviewIntent | null {
  const row = record(value);
  if (
    !row ||
    Reflect.ownKeys(row).length !== 8 ||
    row.broker !== "alpaca" ||
    row.environment !== "paper" ||
    row.kind !== "vertical" ||
    row.symbol !== null ||
    !Number.isSafeInteger(row.quantity) ||
    (row.quantity as number) <= 0 ||
    (row.quantity as number) > 0xffff_ffff ||
    typeof row.limit_price !== "number" ||
    !Number.isFinite(row.limit_price) ||
    row.limit_price <= 0 ||
    !Number.isSafeInteger(row.limit_price * 100) ||
    (row.limit_price * 100) / 100 !== row.limit_price ||
    (row.net_effect !== "debit" && row.net_effect !== "credit") ||
    !Array.isArray(row.legs) ||
    row.legs.length !== 2
  )
    return null;
  const legs: VerticalPreviewIntent["legs"][number][] = [];
  for (const value of row.legs) {
    const leg = record(value);
    if (
      !leg ||
      Reflect.ownKeys(leg).length !== 2 ||
      !string(leg.symbol, 32) ||
      !OCC.test(leg.symbol) ||
      (leg.side !== "buy" && leg.side !== "sell")
    )
      return null;
    legs.push(Object.freeze({ symbol: leg.symbol, side: leg.side }));
  }
  const firstLeg = legs[0];
  const secondLeg = legs[1];
  if (
    !firstLeg ||
    !secondLeg ||
    firstLeg.side === secondLeg.side ||
    firstLeg.symbol === secondLeg.symbol
  )
    return null;
  const first = OCC.exec(firstLeg.symbol);
  const second = OCC.exec(secondLeg.symbol);
  if (
    !first ||
    !second ||
    first[1] !== second[1] ||
    first[2] !== second[2] ||
    first[3] !== second[3] ||
    first[4] === second[4]
  )
    return null;
  const buy = legs.find((leg) => leg.side === "buy");
  const sell = legs.find((leg) => leg.side === "sell");
  if (!buy || !sell) return null;
  const buyContract = OCC.exec(buy.symbol);
  const sellContract = OCC.exec(sell.symbol);
  if (!buyContract || !sellContract) return null;
  const buyStrikeText = buyContract[4];
  const sellStrikeText = sellContract[4];
  if (!buyStrikeText || !sellStrikeText) return null;
  const buyStrike = BigInt(buyStrikeText);
  const sellStrike = BigInt(sellStrikeText);
  const width = buyStrike > sellStrike ? buyStrike - sellStrike : sellStrike - buyStrike;
  if (BigInt(Math.round(row.limit_price * 100)) * 10n >= width) return null;
  const expectedEffect =
    buyContract[3] === "C"
      ? buyStrike < sellStrike
        ? "debit"
        : "credit"
      : buyStrike > sellStrike
        ? "debit"
        : "credit";
  if (row.net_effect !== expectedEffect) return null;
  return Object.freeze({
    broker: "alpaca",
    environment: "paper",
    kind: "vertical",
    symbol: null,
    quantity: row.quantity as number,
    limit_price: row.limit_price,
    net_effect: row.net_effect,
    legs: Object.freeze(legs) as VerticalPreviewIntent["legs"],
  });
}

/** Only accepts an explicit disabled-execution preview receipt. */
export function decodeVerticalPreviewReceipt(
  value: unknown,
  expectedIntent?: VerticalPreviewIntent,
): VerticalPreviewReceipt | null {
  const row = record(value);
  const preview = row && record(row.preview);
  if (
    !row ||
    Reflect.ownKeys(row).length !== 2 ||
    row.execution_enabled !== false ||
    !preview ||
    Reflect.ownKeys(preview).length !== 5 ||
    !string(preview.preview_id, 128) ||
    !string(preview.expires_at, 128) ||
    !Number.isFinite(Date.parse(preview.expires_at)) ||
    typeof preview.estimated_max_loss !== "number" ||
    !Number.isFinite(preview.estimated_max_loss) ||
    preview.estimated_max_loss < 0 ||
    !string(preview.currency, 8) ||
    !/^[A-Z]{3}$/u.test(preview.currency)
  )
    return null;
  const intent = previewIntent(preview.intent);
  if (!intent) return null;
  if (
    expectedIntent &&
    (intent.broker !== expectedIntent.broker ||
      intent.environment !== expectedIntent.environment ||
      intent.kind !== expectedIntent.kind ||
      intent.symbol !== expectedIntent.symbol ||
      intent.quantity !== expectedIntent.quantity ||
      intent.limit_price !== expectedIntent.limit_price ||
      intent.net_effect !== expectedIntent.net_effect ||
      intent.legs.length !== expectedIntent.legs.length ||
      intent.legs.some(
        (leg, index) =>
          leg.symbol !== expectedIntent.legs[index]?.symbol ||
          leg.side !== expectedIntent.legs[index]?.side,
      ))
  )
    return null;
  return Object.freeze({
    executionEnabled: false,
    preview: Object.freeze({
      previewId: preview.preview_id,
      expiresAt: preview.expires_at,
      estimatedMaxLoss: preview.estimated_max_loss,
      currency: preview.currency,
      intent,
    }),
    wire: Object.freeze({ ...row }),
  });
}

export function isCanonicalTicker(value: unknown): value is string {
  return typeof value === "string" && TICKER.test(value);
}
