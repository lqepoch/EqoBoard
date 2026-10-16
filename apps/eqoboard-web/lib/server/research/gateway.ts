import "server-only";

import { NextResponse } from "next/server";

import { parseGatewayBaseUrl } from "../gateway";
import { signGatewayDelegation } from "../bff-security";
import type { ServerPrincipal } from "../auth";
import { readProviderText } from "./transport";

export type GatewayRead<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; response: NextResponse }>;

export type MarketDelegation = Readonly<{ token: string }>;

export async function authorizeMarketDelegation(
  principal: ServerPrincipal,
): Promise<GatewayRead<MarketDelegation>> {
  const delegated = await signGatewayDelegation(principal, "market:read");
  if (!delegated.ok) return { ok: false, response: delegated.response };
  return { ok: true, value: Object.freeze({ token: delegated.token }) };
}

function gatewayBaseUrl(): URL {
  const configured = process.env.EQO_RUST_URL?.trim();
  if (!configured) throw new Error("research-gateway-unconfigured");
  const base = parseGatewayBaseUrl(configured);
  if (!base) throw new Error("research-gateway-unconfigured");
  return base;
}

async function getGatewayJson(base: URL, path: string, token: string): Promise<unknown> {
  const url = new URL(path, base);
  const text = await readProviderText(url, {
    timeoutMs: 12_000,
    maxBytes: 4 * 1024 * 1024,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("research-gateway-response-invalid");
  }
}

function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.length <= 128 ? field : null;
}

function responseError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export type SipSnapshotCollection = Readonly<{
  feed: "sip";
  snapshots: readonly unknown[];
  requestedSymbols: readonly string[];
  receivedAt: string | null;
  sourceLabel: string | null;
  sourceMode: string | null;
  gatewayInstanceId: string | null;
}>;

function splitSymbols(symbols: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < symbols.length; index += size)
    chunks.push(symbols.slice(index, index + size));
  return chunks;
}

async function mapLimit<T, Result>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<Result>,
): Promise<Result[]> {
  const result = new Array<Result>(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const current = index++;
        if (current >= items.length) return;
        const item = items.at(current);
        if (item === undefined) return;
        result[current] = await run(item);
      }
    }),
  );
  return result;
}

/** Calls the existing Rust snapshot API using a short-lived, exact market:read delegation. */
export async function readSipSnapshots(
  principal: ServerPrincipal,
  inputSymbols: readonly string[],
): Promise<GatewayRead<SipSnapshotCollection>> {
  const delegated = await authorizeMarketDelegation(principal);
  if (!delegated.ok) return delegated;
  return readSipSnapshotsWithDelegation(delegated.value, inputSymbols);
}

export async function readSipSnapshotsWithDelegation(
  delegation: MarketDelegation,
  inputSymbols: readonly string[],
): Promise<GatewayRead<SipSnapshotCollection>> {
  const symbols = [...new Set(inputSymbols.map((value) => value.trim().toUpperCase()))];
  if (
    symbols.length < 1 ||
    symbols.length > 1500 ||
    symbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,11}$/u.test(symbol))
  ) {
    return { ok: false, response: responseError(400, "invalid_gateway_symbol_list") };
  }
  let base: URL;
  try {
    base = gatewayBaseUrl();
  } catch {
    return { ok: false, response: responseError(503, "research_gateway_unconfigured") };
  }
  try {
    const batches = await mapLimit(splitSymbols(symbols, 50), 3, async (batch) => {
      const query = new URLSearchParams({ symbols: batch.join(",") });
      return getGatewayJson(base, `/api/v1/stocks/snapshots?${query.toString()}`, delegation.token);
    });
    const snapshots: unknown[] = [];
    let responseMeta: unknown;
    for (const value of batches) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("research-gateway-response-invalid");
      const feed = stringField(value, "feed");
      const rows = Reflect.get(value, "snapshots");
      if (feed !== "sip" || !Array.isArray(rows)) throw new Error("research-gateway-feed-not-sip");
      responseMeta ??= value;
      snapshots.push(...rows.filter((row) => stringField(row, "feed") === "sip"));
    }
    if (snapshots.length > symbols.length) throw new Error("research-gateway-response-invalid");
    return {
      ok: true,
      value: Object.freeze({
        feed: "sip" as const,
        snapshots: Object.freeze(snapshots),
        requestedSymbols: Object.freeze(symbols),
        receivedAt: stringField(responseMeta, "received_at"),
        sourceLabel: stringField(responseMeta, "source_label"),
        sourceMode: stringField(responseMeta, "source_mode"),
        gatewayInstanceId: stringField(responseMeta, "gateway_instance_id"),
      }),
    };
  } catch (error) {
    const code =
      error instanceof Error && error.message === "research-gateway-feed-not-sip"
        ? "research_gateway_feed_not_sip"
        : "research_gateway_unavailable";
    return { ok: false, response: responseError(502, code) };
  }
}

export type SipDailyBars = Readonly<{
  symbol: string;
  timeframe: "1Day";
  feed: "sip";
  bars: readonly unknown[];
}>;

export async function readSipDailyBars(
  principal: ServerPrincipal,
  symbolInput: string,
): Promise<GatewayRead<SipDailyBars>> {
  const delegated = await authorizeMarketDelegation(principal);
  if (!delegated.ok) return delegated;
  return readSipDailyBarsWithDelegation(delegated.value, symbolInput);
}

export async function readSipDailyBarsWithDelegation(
  delegation: MarketDelegation,
  symbolInput: string,
): Promise<GatewayRead<SipDailyBars>> {
  const symbol = symbolInput.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/u.test(symbol)) {
    return { ok: false, response: responseError(400, "invalid_gateway_symbol") };
  }
  let base: URL;
  try {
    base = gatewayBaseUrl();
  } catch {
    return { ok: false, response: responseError(503, "research_gateway_unconfigured") };
  }
  try {
    const query = new URLSearchParams({ symbol, timeframe: "1Day", limit: "390", days: "650" });
    const value = await getGatewayJson(
      base,
      `/api/v1/stocks/bars?${query.toString()}`,
      delegation.token,
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      stringField(value, "feed") !== "sip" ||
      stringField(value, "timeframe") !== "1Day" ||
      stringField(value, "symbol")?.toUpperCase() !== symbol ||
      !Array.isArray(Reflect.get(value, "bars"))
    ) {
      return { ok: false, response: responseError(502, "research_gateway_feed_not_sip") };
    }
    return {
      ok: true,
      value: Object.freeze({
        symbol,
        timeframe: "1Day",
        feed: "sip",
        bars: Object.freeze(Reflect.get(value, "bars") as unknown[]),
      }),
    };
  } catch {
    return { ok: false, response: responseError(502, "research_gateway_unavailable") };
  }
}
