import type {
  ManualPortfolioPositionV1,
  ManualPortfolioTransactionV1,
  ManualPortfolioV1,
} from "../portfolio/contracts";
import { hasControlCharacters, hasOnlyEnumerableDataProperties } from "./validation";

const TICKER = /^[A-Z0-9.^=-]{1,12}$/u;
const MAX_ROWS = 10_000;

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      !hasOnlyEnumerableDataProperties(value)
    )
      return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown, strictMilliseconds = false): value is string {
  if (typeof value !== "string" || hasControlCharacters(value)) return false;
  if (strictMilliseconds && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  if (!strictMilliseconds && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value))
    return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && (!strictMilliseconds || parsed.toISOString() === value)
  );
}

function parsePortfolio(value: unknown): ManualPortfolioV1 | null {
  const row = exactRecord(value, ["id", "name", "created_at"]);
  if (
    !row ||
    !Number.isSafeInteger(row.id) ||
    (row.id as number) <= 0 ||
    typeof row.name !== "string" ||
    row.name.length < 1 ||
    row.name.length > 64 ||
    hasControlCharacters(row.name) ||
    !validTimestamp(row.created_at)
  )
    return null;
  return Object.freeze({ id: row.id as number, name: row.name, created_at: row.created_at });
}

function parseTransaction(value: unknown): ManualPortfolioTransactionV1 | null {
  const row = exactRecord(value, [
    "id",
    "portfolio_id",
    "symbol",
    "side",
    "quantity",
    "price",
    "executed_at",
  ]);
  if (
    !row ||
    !Number.isSafeInteger(row.id) ||
    (row.id as number) <= 0 ||
    !Number.isSafeInteger(row.portfolio_id) ||
    (row.portfolio_id as number) <= 0 ||
    typeof row.symbol !== "string" ||
    !TICKER.test(row.symbol) ||
    (row.side !== "BUY" && row.side !== "SELL") ||
    typeof row.quantity !== "number" ||
    !Number.isFinite(row.quantity) ||
    row.quantity <= 0 ||
    row.quantity > 1_000_000_000 ||
    typeof row.price !== "number" ||
    !Number.isFinite(row.price) ||
    row.price < 0 ||
    row.price > 1_000_000_000 ||
    !validTimestamp(row.executed_at, true)
  )
    return null;
  return Object.freeze({
    id: row.id as number,
    portfolio_id: row.portfolio_id as number,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    price: row.price,
    executed_at: row.executed_at,
  });
}

function parsePosition(value: unknown): ManualPortfolioPositionV1 | null {
  const row = exactRecord(value, ["symbol", "quantity", "avgCost", "realizedPnl"]);
  if (
    !row ||
    typeof row.symbol !== "string" ||
    !TICKER.test(row.symbol) ||
    typeof row.quantity !== "number" ||
    !Number.isFinite(row.quantity) ||
    typeof row.avgCost !== "number" ||
    !Number.isFinite(row.avgCost) ||
    typeof row.realizedPnl !== "number" ||
    !Number.isFinite(row.realizedPnl)
  )
    return null;
  return Object.freeze({
    symbol: row.symbol,
    quantity: row.quantity,
    avgCost: row.avgCost,
    realizedPnl: row.realizedPnl,
  });
}

function decodeRows<T>(value: unknown, parse: (row: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value) || value.length > MAX_ROWS) return null;
  const rows: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return Object.freeze(rows);
}

/** Runtime decoders for the owner-scoped manual-ledger DTOs returned by the BFF. */
export function decodePortfolioList(value: unknown): readonly ManualPortfolioV1[] | null {
  return decodeRows(value, parsePortfolio);
}

export function decodePortfolioPositions(
  value: unknown,
): readonly ManualPortfolioPositionV1[] | null {
  return decodeRows(value, parsePosition);
}

export function decodePortfolioTransactions(
  value: unknown,
): readonly ManualPortfolioTransactionV1[] | null {
  return decodeRows(value, parseTransaction);
}

export function decodePortfolio(value: unknown): ManualPortfolioV1 | null {
  return parsePortfolio(value);
}

export function decodePortfolioTransaction(value: unknown): ManualPortfolioTransactionV1 | null {
  return parseTransaction(value);
}
