import { NextResponse } from "next/server";

import { requireRuntimeMode } from "@/lib/server/runtime-mode";
import { authorizeRequest } from "@/lib/server/bff-security";
import { consumePrincipalRateLimit } from "@/lib/server/rate-limit";
import { authorizeMarketDelegation, readSipDailyBarsWithDelegation, readSipSnapshotsWithDelegation } from "@/lib/server/research/gateway";
import { attachSipEarningsMoves, loadEconomicCalendar, loadEarningsCalendar, loadEarningsHistory } from "@/lib/server/research/calendar";
import { attachMacroSnapshots, loadMacro } from "@/lib/server/research/macro";
import { loadCryptoGlobal, loadCryptoMarkets } from "@/lib/server/research/crypto";
import { loadInsiderTransactions } from "@/lib/server/research/insider";
import { loadNews } from "@/lib/server/research/news";
import { attachSipSnapshots, filterMarketData, loadMarketMetadata, toHeatmap } from "@/lib/server/research/screener";
import { getCached } from "@/lib/server/research/cache";
import { parseResearchOperationInput, type ResearchOperationInput } from "@/lib/server/research/input";
import type { ProviderResult, ResearchEnvelope, ResearchOperationName } from "@/lib/server/research/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_OPERATIONS = new Set<ResearchOperationName>([
  "news", "macro", "economic-calendar", "earnings-calendar", "earnings-history", "insider",
  "screener", "heatmap", "crypto", "crypto-global",
]);

const RATE_LIMITS: Readonly<Record<ResearchOperationName, number>> = Object.freeze({
  news: 30,
  macro: 12,
  "economic-calendar": 12,
  "earnings-calendar": 12,
  "earnings-history": 8,
  insider: 6,
  screener: 4,
  heatmap: 4,
  crypto: 20,
  "crypto-global": 10,
});

const CACHE_TTL_MS: Readonly<Record<ResearchOperationName, number>> = Object.freeze({
  news: 60_000,
  macro: 300_000,
  "economic-calendar": 900_000,
  "earnings-calendar": 3_600_000,
  // Gateway SIP bars are best-effort; keep a brief window so recovery is visible.
  "earnings-history": 60_000,
  insider: 3_600_000,
  screener: 3_000,
  heatmap: 3_000,
  crypto: 5_000,
  "crypto-global": 120_000,
});

class RouteResponseError extends Error {
  constructor(readonly response: NextResponse) {
    super("research-route-response");
    this.name = "RouteResponseError";
  }
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function cacheKey(input: ResearchOperationInput): string {
  return `research:${input.operation}:${JSON.stringify(input)}`;
}

async function loadCached<T>(input: ResearchOperationInput, load: () => Promise<ProviderResult<T>>) {
  const cached = await getCached(cacheKey(input), CACHE_TTL_MS[input.operation], async () => {
    return load();
  });
  const value = cached.value;
  const envelope: ResearchEnvelope<T> = Object.freeze({
    schemaVersion: 1,
    operation: input.operation,
    source: value.source,
    status: value.complete ? "available" : "partial",
    asOf: value.asOf,
    retrievedAt: new Date().toISOString(),
    completeness: Object.freeze({ complete: value.complete, failedItems: value.failedItems, truncated: value.truncated }),
    cache: cached.cache,
    data: value.data,
    warning: value.warning,
  });
  return NextResponse.json(envelope, { headers: { "Cache-Control": "no-store" } });
}

function sourceWith(source: ProviderResult<unknown>["source"], provider: string, sourcePath: string) {
  return Object.freeze({ ...source, provider, sourcePath });
}

function isUsTicker(symbol: string): boolean {
  return /^[A-Z][A-Z0-9-]{0,11}$/u.test(symbol) && symbol !== "VIX";
}

async function dispatch(input: ResearchOperationInput, principal: Parameters<typeof authorizeMarketDelegation>[0]): Promise<NextResponse> {
  switch (input.operation) {
    case "news":
      return loadCached(input, () => loadNews(input.symbol ?? null));
    case "macro": {
      // Enforce both read scopes before making either public-provider or Gateway requests.
      const delegation = await authorizeMarketDelegation(principal);
      if (!delegation.ok) return delegation.response;
      return loadCached(input, async () => {
        const result = await loadMacro(input.region);
        const snapshots = await readSipSnapshotsWithDelegation(delegation.value, result.data.indexProxies.map((item) => item.symbol));
        if (!snapshots.ok) throw new RouteResponseError(snapshots.response);
        const data = attachMacroSnapshots(result.data, snapshots.value.snapshots);
        const unavailable = data.indexObservations.filter((item) => item.price === null).length;
        return {
          ...result,
          source: sourceWith(result.source, `${result.source.provider} + Rust Gateway stock snapshots (feed=sip)`, "apps/openterminal/server/src/providers/fred.ts; apps/openterminal/server/src/providers/ecb.ts; apps/gateway/src/main.rs"),
          data,
          complete: result.complete && unavailable === 0 && snapshots.value.snapshots.length === result.data.indexProxies.length,
          failedItems: (result.failedItems ?? 0) + unavailable,
          warning: `${result.warning} SIP source labels are copied only when supplied by the Gateway.`,
        };
      });
    }
    case "economic-calendar":
      return loadCached(input, loadEconomicCalendar);
    case "earnings-calendar":
      return loadCached(input, () => loadEarningsCalendar(input.symbols ?? []));
    case "earnings-history": {
      const delegation = isUsTicker(input.symbol) ? await authorizeMarketDelegation(principal) : null;
      if (delegation && !delegation.ok) return delegation.response;
      return loadCached(input, async () => {
        let bars: readonly unknown[] | null = null;
        let barWarning: string | null = null;
        if (delegation?.ok) {
          const response = await readSipDailyBarsWithDelegation(delegation.value, input.symbol);
          if (response.ok) bars = response.value.bars;
          else if (response.response.status === 401 || response.response.status === 403) throw new RouteResponseError(response.response);
          else barWarning = "Rust Gateway SIP daily bars are unavailable; EPS surprises are shown without derived price moves.";
        }
        const result = await loadEarningsHistory(input.symbol);
        const data = bars ? attachSipEarningsMoves(result.data, bars) : result.data;
        const complete = result.complete && bars !== null && data.every((row) => row.priceMoveSource !== "unavailable");
        const source = bars
          ? sourceWith(result.source, "Nasdaq earnings surprises + Rust Gateway SIP daily bars", "apps/openterminal/server/src/providers/nasdaq.ts; apps/gateway/src/main.rs")
          : result.source;
        return {
          ...result,
          source,
          data,
          complete,
          failedItems: (result.failedItems ?? 0) + (bars === null ? 1 : data.filter((row) => row.priceMoveSource === "unavailable").length),
          warning: [result.warning, barWarning, isUsTicker(input.symbol) ? null : "No non-U.S. historical price provider is configured for this view."].filter(Boolean).join(" "),
        };
      });
    }
    case "insider":
      return loadCached(input, () => loadInsiderTransactions(input.symbol));
    case "screener":
    case "heatmap": {
      const market = input.market;
      const delegation = market === "us" ? await authorizeMarketDelegation(principal) : null;
      if (delegation && !delegation.ok) return delegation.response;
      return loadCached(input, async () => {
        const metadata = await loadMarketMetadata(market);
        let data = metadata.data;
        if (market === "us" && delegation?.ok && data.rows.length > 0) {
          const symbols = data.rows.map((row) => row.symbol);
          const snapshots = await readSipSnapshotsWithDelegation(delegation.value, symbols);
          if (!snapshots.ok) throw new RouteResponseError(snapshots.response);
          data = attachSipSnapshots(data, snapshots.value);
        }
        if (input.operation === "heatmap") data = toHeatmap(data);
        else data = filterMarketData(data, input);
        const snapshotFailures = market === "us" ? Math.max(0, data.coverage.requested - data.coverage.snapshots) : 0;
        const complete = metadata.complete && data.coverage.complete;
        return {
          ...metadata,
          source: sourceWith(metadata.source, market === "us"
            ? "TradingView scanner metadata + Rust Gateway stock snapshots (feed=sip)"
            : "TradingView scanner + ECB FX (where returned)",
          market === "us"
            ? "apps/openterminal/server/src/providers/tradingview.ts; apps/gateway/src/main.rs"
            : "apps/openterminal/server/src/providers/tradingview.ts; apps/openterminal/server/src/providers/ecb.ts"),
          data,
          complete,
          failedItems: (metadata.failedItems ?? 0) + snapshotFailures,
          truncated: data.truncated,
          warning: market === "us"
            ? "U.S. price, change and volume fields come only from the verified Gateway feed=sip response. Scanner metadata and SIP observations have distinct source timestamps."
            : metadata.warning,
        };
      });
    }
    case "crypto":
      return loadCached(input, loadCryptoMarkets);
    case "crypto-global":
      return loadCached(input, loadCryptoGlobal);
  }
}

export async function GET(request: Request, context: Readonly<{ params: Promise<{ operation: string }> }>): Promise<NextResponse> {
  const modeError = requireRuntimeMode("terminal", request);
  if (modeError) return modeError;
  const { operation } = await context.params;
  if (!ALLOWED_OPERATIONS.has(operation as ResearchOperationName)) return errorResponse("unknown_research_operation", 404);
  const authorization = await authorizeRequest(request, "research:read");
  if (!authorization.ok) return authorization.response;
  const parsed = parseResearchOperationInput(operation, new URL(request.url).searchParams);
  if (!parsed.ok) {
    return errorResponse(parsed.error === "unknown-parameter" ? "unknown_research_parameter" : "invalid_research_input", parsed.error === "unknown-operation" ? 404 : 400);
  }
  const budget = RATE_LIMITS[parsed.value.operation];
  const limited = await consumePrincipalRateLimit(authorization.principal, {
    bucket: `native-research:${parsed.value.operation}`,
    maxRequests: budget,
    windowMs: 60_000,
  });
  if (!limited.allowed) {
    return NextResponse.json({ error: "research_rate_limited" }, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(limited.retryAfterSeconds) },
    });
  }
  try {
    return await dispatch(parsed.value, authorization.principal);
  } catch (error) {
    if (error instanceof RouteResponseError) return error.response;
    if (error instanceof Error && error.message === "sec-contact-unconfigured") return errorResponse("research_provider_unconfigured", 503);
    if (error instanceof Error && error.message === "research-gateway-unconfigured") return errorResponse("research_gateway_unconfigured", 503);
    return errorResponse("research_provider_unavailable", 502);
  }
}
