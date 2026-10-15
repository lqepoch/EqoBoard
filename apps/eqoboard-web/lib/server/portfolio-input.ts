import "server-only";

export type ParsedPortfolioName = Readonly<{ ok: true; name: string }> | Readonly<{ ok: false }>;
export type ParsedPortfolioTransaction =
  | Readonly<{
      ok: true;
      value: Readonly<{
        symbol: string;
        side: "BUY" | "SELL";
        quantity: number;
        price: number;
        executed_at: string;
      }>;
    }>
  | Readonly<{ ok: false }>;

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length &&
    fields.every((field) => Object.hasOwn(record, field))
    ? record
    : null;
}

export function parsePortfolioName(value: unknown): ParsedPortfolioName {
  const record = exactRecord(value, ["name"]);
  if (
    !record ||
    typeof record.name !== "string" ||
    record.name.trim().length < 1 ||
    record.name.length > 64 ||
    /[\u0000-\u001f\u007f]/u.test(record.name)
  )
    return { ok: false };
  return { ok: true, name: record.name.trim() };
}

export function parsePortfolioTransaction(value: unknown): ParsedPortfolioTransaction {
  const record = exactRecord(value, ["symbol", "side", "quantity", "price", "executed_at"]);
  if (
    !record ||
    typeof record.symbol !== "string" ||
    record.symbol.trim() !== record.symbol ||
    record.symbol.length < 1 ||
    record.symbol.length > 12 ||
    /[^A-Za-z0-9.^=-]/u.test(record.symbol) ||
    (record.side !== "BUY" && record.side !== "SELL") ||
    typeof record.quantity !== "number" ||
    !Number.isFinite(record.quantity) ||
    record.quantity <= 0 ||
    record.quantity > 1_000_000_000 ||
    typeof record.price !== "number" ||
    !Number.isFinite(record.price) ||
    record.price < 0 ||
    record.price > 1_000_000_000 ||
    typeof record.executed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.executed_at)
  ) {
    return { ok: false };
  }
  const date = new Date(record.executed_at);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== record.executed_at)
    return { ok: false };
  return {
    ok: true,
    value: {
      symbol: record.symbol.toUpperCase(),
      side: record.side,
      quantity: record.quantity,
      price: record.price,
      executed_at: record.executed_at,
    },
  };
}
