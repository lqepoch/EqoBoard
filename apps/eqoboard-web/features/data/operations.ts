import type { Permission } from "../../lib/contracts/auth";
import type {
  ManualPortfolioPositionV1,
  ManualPortfolioTransactionV1,
  ManualPortfolioV1,
} from "../portfolio/contracts";
import { parseResearchAiRequest } from "../research/ai";
import type { ResearchAiActionInput, ResearchAiActionOutput } from "../research/ai";
import type { YfinanceResearchInput } from "../research/yfinance-contract";

/**
 * Closed browser read boundary. Inputs only contain bounded domain intent; a
 * caller cannot supply a URL, method, headers, or provider name. Wire payloads
 * remain unknown until the owning feature adapter validates the original
 * Gateway/Core/provider contract.
 */
export type NativeDataOperationMap = {
  "market.quotes": { input: Readonly<{ symbols: readonly string[] }>; output: unknown };
  "market.options.chain": { input: Readonly<{ symbol: string; expiry: string }>; output: unknown };
  "market.status": { input: Readonly<Record<string, never>>; output: unknown };
  "market.history.core-bars": { input: CoreBarsReadInput; output: unknown };
  "market.archive.diagnostic-bars": {
    input: Readonly<{ datasetId: string; symbol: string }>;
    output: unknown;
  };
  "research.yahoo.daily": { input: NativeYahooDailyInput; output: unknown };
  "research.predictions": { input: Readonly<{ runId: string }>; output: unknown };
  "engine.status": { input: Readonly<Record<string, never>>; output: unknown };
  "engine.preview": { input: Readonly<Record<string, never>>; output: unknown };
  "research.news": { input: Readonly<{ symbol?: string }>; output: unknown };
  "research.recap": { input: Readonly<Record<string, never>>; output: unknown };
  "research.symbolSearch": { input: Readonly<{ query: string }>; output: unknown };
  "research.macro": { input: Readonly<{ region: "us" | "eu" }>; output: unknown };
  "research.economicCalendar": { input: Readonly<Record<string, never>>; output: unknown };
  "research.earningsCalendar": {
    input: Readonly<{ symbols?: readonly string[] }>;
    output: unknown;
  };
  "research.earningsHistory": { input: Readonly<{ symbol: string }>; output: unknown };
  "research.insider": { input: Readonly<{ symbol: string }>; output: unknown };
  "research.screener": {
    input: Readonly<{
      market: "us" | "eu";
      sector?: string;
      marketCapMin?: number;
      changeMin?: number;
      changeMax?: number;
      volumeMin?: number;
      sort?: "marketCap" | "price" | "changePercent" | "volume";
      direction?: "asc" | "desc";
      limit?: number;
    }>;
    output: unknown;
  };
  "research.heatmap": { input: Readonly<{ market: "us" | "eu" }>; output: unknown };
  "research.crypto": { input: Readonly<Record<string, never>>; output: unknown };
  "research.cryptoGlobal": { input: Readonly<Record<string, never>>; output: unknown };
  "portfolio.list": {
    input: Readonly<Record<string, never>>;
    output: readonly ManualPortfolioV1[];
  };
  "portfolio.positions": {
    input: Readonly<{ portfolioId: number }>;
    output: readonly ManualPortfolioPositionV1[];
  };
  "portfolio.transactions": {
    input: Readonly<{ portfolioId: number }>;
    output: readonly ManualPortfolioTransactionV1[];
  };
};

export type NativeDataOperationId = keyof NativeDataOperationMap;
export type NativeDataOperationInput<Id extends NativeDataOperationId> =
  NativeDataOperationMap[Id]["input"];

/** Fixed Yahoo observation read; this provider-native envelope is not Core Bars. */
export type NativeYahooDailyInput = YfinanceResearchInput;

/** Fixed history BFF request selection; the financial response remains Core Bars V1. */
export type CoreBarsReadInput = Readonly<{
  symbol: string;
  range?: "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";
  resolution?: "1m" | "5m" | "15m" | "1h" | "1d";
  asset_class?: "stock" | "etf";
  session_scope?: "all" | "regular" | "extended" | "overnight";
  adjustment?: "unadjusted" | "split" | "dividend" | "all";
  provider_mode?: "auto" | "alpaca_only" | "futu_only";
  allow_daily_downgrade?: boolean;
  request_start?: string;
  request_end?: string;
  cursor?: string;
}>;

export type NativeActionMap = {
  "orders.preview.vertical": { input: VerticalPreviewIntent; output: unknown };
  "portfolio.create": { input: Readonly<{ name: string }>; output: ManualPortfolioV1 };
  "portfolio.delete": { input: Readonly<{ portfolioId: number }>; output: void };
  "portfolio.transaction.create": {
    input: Readonly<{
      portfolioId: number;
      symbol: string;
      side: "BUY" | "SELL";
      quantity: number;
      price: number;
      executed_at: string;
    }>;
    output: ManualPortfolioTransactionV1;
  };
  "portfolio.transaction.delete": {
    input: Readonly<{ portfolioId: number; transactionId: number }>;
    output: void;
  };
  "research.ai": {
    input: ResearchAiActionInput;
    output: ResearchAiActionOutput;
  };
};

/** Existing Rust OrderIntent request shape for the read-only preview route. */
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

export type NativeActionId = keyof NativeActionMap;

export type NativeOperationPermission = Readonly<
  Record<NativeDataOperationId, Permission | readonly Permission[]>
>;

export const NATIVE_OPERATION_PERMISSION: NativeOperationPermission = Object.freeze({
  "market.quotes": "market:read",
  "market.options.chain": "market:read",
  "market.status": "market:read",
  "market.history.core-bars": "market:read",
  "market.archive.diagnostic-bars": "market:read",
  "research.yahoo.daily": "research:read",
  "research.predictions": "research:private-read",
  "engine.status": "engine:offline-read",
  "engine.preview": "engine:offline-read",
  "research.news": "research:read",
  "research.recap": Object.freeze(["research:read", "market:read"] as const),
  "research.symbolSearch": "research:read",
  "research.macro": "research:read",
  "research.economicCalendar": "research:read",
  "research.earningsCalendar": "research:read",
  "research.earningsHistory": "research:read",
  "research.insider": "research:read",
  "research.screener": "research:read",
  "research.heatmap": "research:read",
  "research.crypto": "research:read",
  "research.cryptoGlobal": "research:read",
  "portfolio.list": "workspace:read",
  "portfolio.positions": "workspace:read",
  "portfolio.transactions": "workspace:read",
});

type NativeHttpRequest = Readonly<{
  method: "GET";
  path: string;
  body?: never;
  permission: Permission | readonly Permission[];
}>;

type NativeActionRequest = Readonly<{
  method: "POST" | "DELETE";
  path: string;
  body?: unknown;
  permission: Permission;
}>;

const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const RESEARCH_TICKER = /^[A-Z0-9.^-]{1,16}$/u;
const CONTRACT = /^[A-Z0-9.]{1,10}\d{6}[CP]\d{8}$/u;
// The preview service currently accepts only standard alphabetic OCC roots.
const PREVIEW_CONTRACT = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/u;
const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ARCHIVE_SYMBOL = /^[A-Z0-9.-]{1,16}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || FORBIDDEN_KEYS.has(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor || !descriptor.enumerable || !("value" in descriptor);
      })
    )
      return null;
    const names = keys as string[];
    if (
      required.some((key) => !names.includes(key)) ||
      names.some((key) => !required.includes(key) && !optional.includes(key))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function validTicker(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROL.test(value) &&
    TICKER.test(value)
  );
}

function validResearchTicker(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROL.test(value) &&
    RESEARCH_TICKER.test(value)
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validRfc3339(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function sortedUniqueSymbols(
  value: unknown,
  max: number,
  contract = false,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  const symbols: string[] = [];
  for (const symbol of value) {
    if (
      typeof symbol !== "string" ||
      symbol !== symbol.trim() ||
      CONTROL.test(symbol) ||
      !(contract ? CONTRACT : TICKER).test(symbol)
    )
      return null;
    if (symbols.includes(symbol)) return null;
    symbols.push(symbol);
  }
  return Object.freeze(symbols);
}

function query(entries: readonly (readonly [string, string])[]): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);
  return params.size > 0 ? `?${params.toString()}` : "";
}

function requiredSymbol(input: unknown): string | null {
  const record = exactRecord(input, ["symbol"]);
  return record && validTicker(record.symbol) ? record.symbol : null;
}

/** Validate and compile only the fixed, audited GET operation set. */
export function buildNativeReadRequest<Id extends NativeDataOperationId>(
  operationId: Id,
  input: NativeDataOperationMap[Id]["input"],
): NativeHttpRequest | null {
  const permission = NATIVE_OPERATION_PERMISSION[operationId];
  switch (operationId) {
    case "market.quotes": {
      const record = exactRecord(input, ["symbols"]);
      const symbols = record && sortedUniqueSymbols(record.symbols, 50);
      if (!symbols) return null;
      return {
        method: "GET",
        path: `/api/quotes${query([["symbols", symbols.join(",")]])}`,
        permission,
      };
    }
    case "market.options.chain": {
      const record = exactRecord(input, ["symbol", "expiry"]);
      if (!record || !validTicker(record.symbol) || !validDate(record.expiry)) return null;
      return {
        method: "GET",
        path: `/api/options/${encoded(record.symbol)}${query([["expiry", record.expiry]])}`,
        permission,
      };
    }
    case "market.status": {
      if (!exactRecord(input, [])) return null;
      return { method: "GET", path: "/api/status", permission };
    }
    case "market.history.core-bars": {
      const record = exactRecord(
        input,
        ["symbol"],
        [
          "range",
          "resolution",
          "asset_class",
          "session_scope",
          "adjustment",
          "provider_mode",
          "allow_daily_downgrade",
          "request_start",
          "request_end",
          "cursor",
        ],
      );
      if (!record || !validTicker(record.symbol)) return null;
      const entries: [string, string][] = [];
      const ranges = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];
      const resolutions = ["1m", "5m", "15m", "1h", "1d"];
      const adjustments = ["unadjusted", "split", "dividend", "all"];
      if (record.range !== undefined) {
        if (typeof record.range !== "string" || !ranges.includes(record.range)) return null;
        entries.push(["range", record.range]);
      }
      if (record.resolution !== undefined) {
        if (typeof record.resolution !== "string" || !resolutions.includes(record.resolution))
          return null;
        entries.push(["resolution", record.resolution]);
      }
      if (record.asset_class !== undefined) {
        if (record.asset_class !== "stock" && record.asset_class !== "etf") return null;
        entries.push(["asset_class", record.asset_class]);
      }
      if (record.session_scope !== undefined) {
        if (!["all", "regular", "extended", "overnight"].includes(record.session_scope as string))
          return null;
        entries.push(["session_scope", record.session_scope as string]);
      }
      if (record.adjustment !== undefined) {
        if (typeof record.adjustment !== "string" || !adjustments.includes(record.adjustment))
          return null;
        entries.push(["adjustment", record.adjustment]);
      }
      if (record.provider_mode !== undefined) {
        if (!["auto", "alpaca_only", "futu_only"].includes(record.provider_mode as string))
          return null;
        entries.push(["provider_mode", record.provider_mode as string]);
      }
      if (record.allow_daily_downgrade !== undefined) {
        if (typeof record.allow_daily_downgrade !== "boolean") return null;
        entries.push(["allow_daily_downgrade", String(record.allow_daily_downgrade)]);
      }
      const pageFields = ["request_start", "request_end", "cursor"] as const;
      const pageCount = pageFields.filter((field) => record[field] !== undefined).length;
      if (pageCount !== 0 && pageCount !== pageFields.length) return null;
      if (pageCount === pageFields.length) {
        if (
          !validRfc3339(record.request_start) ||
          !validRfc3339(record.request_end) ||
          record.request_start >= record.request_end ||
          typeof record.cursor !== "string" ||
          record.cursor.length < 1 ||
          new TextEncoder().encode(record.cursor).byteLength > 2_048 ||
          CONTROL.test(record.cursor)
        )
          return null;
        entries.push(
          ["request_start", record.request_start],
          ["request_end", record.request_end],
          ["cursor", record.cursor],
        );
      }
      const suffix = query(entries);
      if (new TextEncoder().encode(suffix).byteLength > 4_096) return null;
      return { method: "GET", path: `/api/history/${encoded(record.symbol)}${suffix}`, permission };
    }
    case "market.archive.diagnostic-bars": {
      const record = exactRecord(input, ["datasetId", "symbol"]);
      if (
        !record ||
        typeof record.datasetId !== "string" ||
        !DATASET_ID.test(record.datasetId) ||
        typeof record.symbol !== "string" ||
        !ARCHIVE_SYMBOL.test(record.symbol)
      )
        return null;
      return {
        method: "GET",
        path: `/api/eqo/market-data/datasets/${encoded(record.datasetId)}/bars${query([
          ["namespace", "diagnostic"],
          ["symbol", record.symbol],
        ])}`,
        permission,
      };
    }
    case "research.yahoo.daily": {
      const record = exactRecord(
        input,
        ["symbol", "assetClass", "startUtc", "endUtc", "adjustment"],
        ["cursor"],
      );
      if (
        !record ||
        !validTicker(record.symbol) ||
        (record.assetClass !== "stock" && record.assetClass !== "etf") ||
        !validRfc3339(record.startUtc) ||
        !validRfc3339(record.endUtc) ||
        record.startUtc >= record.endUtc ||
        Date.parse(record.endUtc) - Date.parse(record.startUtc) > 36_500 * 86_400_000 ||
        (record.adjustment !== "unadjusted" && record.adjustment !== "adjusted") ||
        (record.cursor !== undefined &&
          (typeof record.cursor !== "string" ||
            record.cursor.length < 1 ||
            new TextEncoder().encode(record.cursor).byteLength > 8_192 ||
            CONTROL.test(record.cursor)))
      )
        return null;
      const entries: [string, string][] = [
        ["symbols", record.symbol],
        ["asset_class", record.assetClass],
        ["start_utc", record.startUtc],
        ["end_utc", record.endUtc],
        ["adjustment", record.adjustment],
      ];
      if (record.cursor !== undefined) entries.push(["cursor", record.cursor as string]);
      const suffix = query(entries);
      if (new TextEncoder().encode(suffix).byteLength > 32_768) return null;
      return { method: "GET", path: `/api/research/yfinance/daily${suffix}`, permission };
    }
    case "research.predictions": {
      const record = exactRecord(input, ["runId"]);
      if (
        !record ||
        typeof record.runId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/u.test(record.runId)
      )
        return null;
      return {
        method: "GET",
        path: `/api/eqo/research/predictions/${encoded(record.runId)}`,
        permission,
      };
    }
    case "engine.status":
    case "engine.preview": {
      if (!exactRecord(input, [])) return null;
      const resource = operationId === "engine.status" ? "status" : "preview";
      return { method: "GET", path: `/api/eqo/engine/${resource}`, permission };
    }
    case "research.earningsHistory":
    case "research.insider": {
      const symbol = requiredSymbol(input);
      if (!symbol) return null;
      const path = `/api/research/data/${operationId === "research.earningsHistory" ? "earnings-history" : "insider"}`;
      return { method: "GET", path: `${path}${query([["symbol", symbol]])}`, permission };
    }
    case "research.news": {
      const record = exactRecord(input, [], ["symbol"]);
      if (!record || (record.symbol !== undefined && !validResearchTicker(record.symbol)))
        return null;
      return {
        method: "GET",
        path: `/api/research/data/news${record.symbol ? query([["symbol", record.symbol]]) : ""}`,
        permission,
      };
    }
    case "research.recap": {
      if (!exactRecord(input, [])) return null;
      return { method: "GET", path: "/api/research/data/recap", permission };
    }
    case "research.symbolSearch": {
      const record = exactRecord(input, ["query"]);
      const queryText = record?.query;
      if (
        typeof queryText !== "string" ||
        queryText.length < 1 ||
        queryText.length > 64 ||
        queryText.trim() !== queryText ||
        CONTROL.test(queryText)
      )
        return null;
      return {
        method: "GET",
        path: `/api/research/data/symbol-search${query([["query", queryText]])}`,
        permission,
      };
    }
    case "research.macro": {
      const record = exactRecord(input, ["region"]);
      if (!record || (record.region !== "us" && record.region !== "eu")) return null;
      return {
        method: "GET",
        path: `/api/research/data/macro${query([["region", record.region]])}`,
        permission,
      };
    }
    case "research.economicCalendar":
    case "research.crypto":
    case "research.cryptoGlobal": {
      if (!exactRecord(input, [])) return null;
      const route =
        operationId === "research.economicCalendar"
          ? "economic-calendar"
          : operationId === "research.crypto"
            ? "crypto"
            : "crypto-global";
      return { method: "GET", path: `/api/research/data/${route}`, permission };
    }
    case "research.earningsCalendar": {
      const record = exactRecord(input, [], ["symbols"]);
      if (!record) return null;
      if (record.symbols === undefined)
        return { method: "GET", path: "/api/research/data/earnings-calendar", permission };
      const symbols = sortedUniqueSymbols(record.symbols, 30);
      if (!symbols) return null;
      return {
        method: "GET",
        path: `/api/research/data/earnings-calendar${query([["symbols", symbols.join(",")]])}`,
        permission,
      };
    }
    case "research.screener": {
      const record = exactRecord(
        input,
        ["market"],
        [
          "sector",
          "marketCapMin",
          "changeMin",
          "changeMax",
          "volumeMin",
          "sort",
          "direction",
          "limit",
        ],
      );
      if (!record || (record.market !== "us" && record.market !== "eu")) return null;
      const entries: [string, string][] = [["market", record.market]];
      if (record.sector !== undefined) {
        if (
          typeof record.sector !== "string" ||
          record.sector.length < 1 ||
          record.sector.length > 64 ||
          record.sector.trim() !== record.sector ||
          CONTROL.test(record.sector)
        )
          return null;
        entries.push(["sector", record.sector]);
      }
      const ranges: Readonly<Record<string, readonly [number, number]>> = {
        marketCapMin: [0, Number.MAX_SAFE_INTEGER],
        changeMin: [-100, 1000],
        changeMax: [-100, 1000],
        volumeMin: [0, Number.MAX_SAFE_INTEGER],
      };
      for (const [key, bounds] of Object.entries(ranges)) {
        const value = record[key];
        if (value === undefined) continue;
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < bounds[0] ||
          value > bounds[1]
        )
          return null;
        entries.push([key, String(value)]);
      }
      if (
        record.changeMin !== undefined &&
        record.changeMax !== undefined &&
        (record.changeMin as number) > (record.changeMax as number)
      )
        return null;
      if (record.sort !== undefined) {
        if (
          !(["marketCap", "price", "changePercent", "volume"] as const).includes(
            record.sort as never,
          )
        )
          return null;
        entries.push(["sort", record.sort as string]);
      }
      if (record.direction !== undefined) {
        if (record.direction !== "asc" && record.direction !== "desc") return null;
        entries.push(["direction", record.direction]);
      }
      if (record.limit !== undefined) {
        if (
          !Number.isSafeInteger(record.limit) ||
          (record.limit as number) < 1 ||
          (record.limit as number) > 500
        )
          return null;
        entries.push(["limit", String(record.limit)]);
      }
      return { method: "GET", path: `/api/research/data/screener${query(entries)}`, permission };
    }
    case "research.heatmap": {
      const record = exactRecord(input, ["market"]);
      if (!record || (record.market !== "us" && record.market !== "eu")) return null;
      return {
        method: "GET",
        path: `/api/research/data/heatmap${query([["market", record.market]])}`,
        permission,
      };
    }
    case "portfolio.list": {
      if (!exactRecord(input, [])) return null;
      return { method: "GET", path: "/api/portfolios", permission };
    }
    case "portfolio.positions":
    case "portfolio.transactions": {
      const record = exactRecord(input, ["portfolioId"]);
      if (
        !record ||
        !Number.isSafeInteger(record.portfolioId) ||
        (record.portfolioId as number) <= 0
      )
        return null;
      const resource = operationId === "portfolio.positions" ? "positions" : "transactions";
      return {
        method: "GET",
        path: `/api/portfolios/${record.portfolioId}/${resource}`,
        permission,
      };
    }
    default: {
      const exhaustive: never = operationId;
      return exhaustive;
    }
  }
}

export function isNativeDataOperationId(value: string): value is NativeDataOperationId {
  return Object.hasOwn(NATIVE_OPERATION_PERMISSION, value);
}

function validPortfolioTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

/** Fixed actions remain separate from read operations and never include submission. */
export function buildNativeActionRequest(
  actionId: NativeActionId,
  body: unknown,
): NativeActionRequest | null {
  if (actionId === "research.ai") {
    try {
      const record = exactRecord(body, ["messages"]);
      if (!record || !Array.isArray(record.messages)) return null;
      const messages: unknown[] = [];
      for (const raw of record.messages) {
        const message = exactRecord(raw, ["role", "content"]);
        if (!message) return null;
        messages.push({ role: message.role, content: message.content });
      }
      const parsed = parseResearchAiRequest({ messages });
      if (!parsed.ok) return null;
      return {
        method: "POST",
        path: "/api/research/ai",
        permission: "research:ai",
        body: parsed.value,
      };
    } catch {
      return null;
    }
  }

  if (actionId === "portfolio.create") {
    const record = exactRecord(body, ["name"]);
    if (
      !record ||
      typeof record.name !== "string" ||
      record.name !== record.name.trim() ||
      record.name.length < 1 ||
      record.name.length > 64 ||
      CONTROL.test(record.name)
    )
      return null;
    return {
      method: "POST",
      path: "/api/portfolios",
      permission: "workspace:write",
      body: { name: record.name },
    };
  }

  if (actionId === "portfolio.delete") {
    const record = exactRecord(body, ["portfolioId"]);
    if (!record || !Number.isSafeInteger(record.portfolioId) || (record.portfolioId as number) <= 0)
      return null;
    return {
      method: "DELETE",
      path: `/api/portfolios/${record.portfolioId}`,
      permission: "workspace:write",
    };
  }

  if (actionId === "portfolio.transaction.create") {
    const record = exactRecord(body, [
      "portfolioId",
      "symbol",
      "side",
      "quantity",
      "price",
      "executed_at",
    ]);
    const symbol = typeof record?.symbol === "string" ? record.symbol.toUpperCase() : "";
    if (
      !record ||
      !Number.isSafeInteger(record.portfolioId) ||
      (record.portfolioId as number) <= 0 ||
      typeof record.symbol !== "string" ||
      !/^[A-Z0-9.^=-]{1,12}$/u.test(symbol) ||
      (record.side !== "BUY" && record.side !== "SELL") ||
      typeof record.quantity !== "number" ||
      !Number.isFinite(record.quantity) ||
      record.quantity <= 0 ||
      record.quantity > 1_000_000_000 ||
      typeof record.price !== "number" ||
      !Number.isFinite(record.price) ||
      record.price < 0 ||
      record.price > 1_000_000_000 ||
      !validPortfolioTimestamp(record.executed_at)
    )
      return null;
    return {
      method: "POST",
      path: `/api/portfolios/${record.portfolioId}/transactions`,
      permission: "workspace:write",
      body: {
        symbol,
        side: record.side,
        quantity: record.quantity,
        price: record.price,
        executed_at: record.executed_at,
      },
    };
  }

  if (actionId === "portfolio.transaction.delete") {
    const record = exactRecord(body, ["portfolioId", "transactionId"]);
    if (
      !record ||
      !Number.isSafeInteger(record.portfolioId) ||
      (record.portfolioId as number) <= 0 ||
      !Number.isSafeInteger(record.transactionId) ||
      (record.transactionId as number) <= 0
    )
      return null;
    return {
      method: "DELETE",
      path: `/api/portfolios/${record.portfolioId}/transactions/${record.transactionId}`,
      permission: "workspace:write",
    };
  }

  if (actionId !== "orders.preview.vertical") return null;

  const record = exactRecord(body, [
    "broker",
    "environment",
    "kind",
    "symbol",
    "quantity",
    "limit_price",
    "net_effect",
    "legs",
  ]);
  if (
    !record ||
    !["alpaca", "ibkr", "schwab"].includes(record.broker as string) ||
    record.environment !== "paper" ||
    record.kind !== "vertical" ||
    record.symbol !== null ||
    !Number.isSafeInteger(record.quantity) ||
    (record.quantity as number) < 1 ||
    (record.quantity as number) > 0xffff_ffff ||
    typeof record.limit_price !== "number" ||
    !Number.isFinite(record.limit_price) ||
    record.limit_price <= 0 ||
    !/^\d+(?:\.\d{1,2})?$/u.test(String(record.limit_price)) ||
    !Number.isSafeInteger(record.limit_price * 100) ||
    (record.limit_price * 100) / 100 !== record.limit_price ||
    (record.net_effect !== "debit" && record.net_effect !== "credit") ||
    !Array.isArray(record.legs) ||
    record.legs.length !== 2
  )
    return null;
  const legs: { symbol: string; side: "buy" | "sell" }[] = [];
  for (const raw of record.legs) {
    const leg = exactRecord(raw, ["symbol", "side"]);
    if (
      !leg ||
      typeof leg.symbol !== "string" ||
      !PREVIEW_CONTRACT.test(leg.symbol) ||
      (leg.side !== "buy" && leg.side !== "sell")
    )
      return null;
    legs.push({ symbol: leg.symbol, side: leg.side });
  }
  if (legs[0]?.symbol === legs[1]?.symbol || legs[0]?.side === legs[1]?.side) return null;
  const firstContract = PREVIEW_CONTRACT.exec(legs[0]?.symbol ?? "");
  const secondContract = PREVIEW_CONTRACT.exec(legs[1]?.symbol ?? "");
  if (
    !firstContract ||
    !secondContract ||
    firstContract[1] !== secondContract[1] ||
    firstContract[2] !== secondContract[2] ||
    firstContract[3] !== secondContract[3] ||
    firstContract[4] === secondContract[4]
  )
    return null;
  const buy = legs.find((leg) => leg.side === "buy");
  const sell = legs.find((leg) => leg.side === "sell");
  if (!buy || !sell) return null;
  const buyContract = PREVIEW_CONTRACT.exec(buy.symbol);
  const sellContract = PREVIEW_CONTRACT.exec(sell.symbol);
  if (!buyContract || !sellContract) return null;
  const buyStrike = BigInt(buyContract[4]!);
  const sellStrike = BigInt(sellContract[4]!);
  const width = buyStrike > sellStrike ? buyStrike - sellStrike : sellStrike - buyStrike;
  const limitCents = BigInt(Math.round(record.limit_price * 100));
  if (limitCents * 10n >= width) return null;
  const inferredEffect =
    buyContract[3] === "C"
      ? buyStrike < sellStrike
        ? "debit"
        : "credit"
      : buyStrike > sellStrike
        ? "debit"
        : "credit";
  if (record.net_effect !== inferredEffect) return null;
  return {
    method: "POST",
    path: "/api/eqo/orders/preview",
    permission: "orders:preview",
    body: {
      broker: record.broker,
      environment: "paper",
      kind: "vertical",
      symbol: record.symbol,
      quantity: record.quantity,
      limit_price: record.limit_price,
      net_effect: record.net_effect,
      legs,
    },
  };
}
