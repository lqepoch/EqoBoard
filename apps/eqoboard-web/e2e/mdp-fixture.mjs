import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OIDC_ISSUER = "http://native-mock-oidc:4450";
const ROUTE = "/v1/research/yfinance/daily";
const MAX_RANGE_DAYS = 36_500;
const PAGE_DAYS = 3_650;
const MAX_PAGE_INDEX = 9;
const FIXTURE_LABEL = "native-e2e synthetic fixture; not provider data";

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function decodeSegment(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function equalBytes(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validSecret(value) {
  return typeof value === "string" && value.length >= 64 && /^[\x21-\x7e]+$/u.test(value);
}

function verifyResearchDelegation(raw, secret) {
  if (!validSecret(secret) || typeof raw !== "string" || raw.length > 8_192) return false;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return false;
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (
    !header ||
    !claims ||
    header.alg !== "HS256" ||
    header.typ !== "JWT" ||
    header.kid !== "mdp-research"
  )
    return false;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  let signature;
  try {
    signature = Buffer.from(parts[2], "base64url");
  } catch {
    return false;
  }
  if (!equalBytes(expected, signature)) return false;

  const now = Math.floor(Date.now() / 1_000);
  return (
    claims.iss === "openterminal-research" &&
    claims.aud === "lqepoch-market-data" &&
    claims.idp_iss === OIDC_ISSUER &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    claims.sub.length <= 255 &&
    typeof claims.jti === "string" &&
    claims.jti.length > 0 &&
    claims.jti.length <= 128 &&
    typeof claims.iat === "number" &&
    Number.isSafeInteger(claims.iat) &&
    claims.iat <= now + 30 &&
    typeof claims.exp === "number" &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > now &&
    claims.exp - claims.iat <= 60 &&
    Array.isArray(claims.scope) &&
    claims.scope.length === 1 &&
    claims.scope[0] === "market:read"
  );
}

function readRequest(url) {
  const permitted = new Set([
    "symbols",
    "asset_class",
    "start_utc",
    "end_utc",
    "adjustment",
    "cursor",
  ]);
  const params = url.searchParams;
  if (
    [...params.keys()].some((key) => !permitted.has(key)) ||
    [...permitted].some((key) => params.getAll(key).length > 1)
  )
    return null;
  const symbol = params.get("symbols");
  const assetClass = params.get("asset_class");
  const start = params.get("start_utc");
  const end = params.get("end_utc");
  const adjustment = params.get("adjustment");
  const cursor = params.get("cursor");
  if (
    !symbol ||
    !/^[A-Z][A-Z0-9.-]{0,11}$/u.test(symbol) ||
    !start ||
    !end ||
    !["stock", "etf"].includes(assetClass) ||
    !["unadjusted", "adjusted"].includes(adjustment)
  )
    return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const cursorMatch = cursor === null ? null : /^older:([1-9])$/u.exec(cursor);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    endMs - startMs > MAX_RANGE_DAYS * 86_400_000 ||
    (cursor !== null && !cursorMatch)
  )
    return null;
  return {
    symbol,
    assetClass,
    start,
    end,
    startMs,
    endMs,
    adjustment,
    cursor,
    pageIndex: cursorMatch ? Number(cursorMatch[1]) : 0,
  };
}

function syntheticObservation(input) {
  const pageEndMs = input.endMs - input.pageIndex * PAGE_DAYS * 86_400_000;
  const pageStartMs = Math.max(input.startMs, pageEndMs - PAGE_DAYS * 86_400_000);
  if (pageStartMs >= pageEndMs || pageEndMs > input.endMs) return null;
  const pageStart = new Date(pageStartMs).toISOString();
  const pageEnd = new Date(pageEndMs).toISOString();
  const nextCursor = pageStartMs > input.startMs ? `older:${input.pageIndex + 1}` : null;
  if (input.pageIndex >= MAX_PAGE_INDEX && nextCursor !== null) return null;

  const timestamps = Array.from(
    { length: 25 },
    (_, index) => pageEndMs - (25 - index) * 86_400_000,
  ).filter((time) => time >= pageStartMs && time < pageEndMs);
  if (timestamps.length === 0) return null;
  const bars = timestamps.map((time, index) => {
    const value = 100 + index / 10;
    return {
      symbol: input.symbol,
      asset_class: input.assetClass,
      event_ts_utc: new Date(time).toISOString(),
      resolution: "1d",
      adjustment: input.adjustment,
      open: value.toFixed(4),
      high: (value + 1).toFixed(4),
      low: (value - 1).toFixed(4),
      close: (value + 0.25).toFixed(4),
      adj_close: null,
      volume: "123456",
      dividends: null,
      stock_splits: null,
    };
  });
  const now = new Date().toISOString();
  const offsetNow = now.replace(/Z$/u, "+00:00");
  const offsetStart = pageStart.replace(/Z$/u, "+00:00");
  const offsetEnd = pageEnd.replace(/Z$/u, "+00:00");
  const rowTimes = bars.map((bar) => bar.event_ts_utc);
  const payload = {
    schema_version: "yfinance-history-bridge-v1",
    status: "ready",
    provider: "yfinance",
    source: "Yahoo Finance",
    asset_class: input.assetClass,
    classification_source: "caller_declared",
    resolution: "1d",
    effective_resolution: "1d",
    adjustment: input.adjustment,
    provider_adjustment_semantics: "unknown_or_provider_native",
    adjustment_confirmed_raw: false,
    provider_repair_enabled: false,
    numeric_encoding: "binary_float_projection",
    volume_encoding: "integer_exact_or_safe_integer_float",
    canonical: false,
    point_in_time: false,
    executable: false,
    display_only: true,
    requested_range: { start: pageStart, end: pageEnd, semantics: "start_inclusive_end_exclusive" },
    requested_symbols: [input.symbol],
    returned_symbols: [input.symbol],
    missing_symbols: [],
    available_at: now,
    fetched_at: now,
    source_observed_at: now,
    request_started_at: now,
    cache_status: "network",
    freshness: "retrieved",
    coverage: {
      requested_start: pageStart,
      requested_end: pageEnd,
      bar_count: bars.length,
      per_symbol: [
        {
          symbol: input.symbol,
          bar_count: bars.length,
          first_bar_at: rowTimes[0],
          last_bar_at: rowTimes.at(-1),
          gaps: ["DATE_GAPS_UNASSESSED", "SYMBOL_RENAME_HISTORY_UNAVAILABLE"],
        },
      ],
      gaps: [
        { code: "DATE_GAPS_UNASSESSED" },
        { code: "SYMBOL_RENAME_HISTORY_UNAVAILABLE" },
        { code: "NON_POINT_IN_TIME_PROVIDER_HISTORY" },
      ],
      calendar_gaps_assessed: false,
    },
    action_coverage: {
      dividends: "provider_field_unavailable",
      stock_splits: "provider_field_unavailable",
      symbol_renames: "unsupported",
    },
    actions: [],
    bars,
    provenance: {
      acquired_at: offsetNow,
      // Stable identifier for the visibly synthetic fixture, based on the accepted OpenTerminal DTO contract.
      adapter_version: "bounded-synthetic-e2e-v1",
      adjustment: input.adjustment,
      cache_status: "network",
      config_fingerprint: "a".repeat(64),
      end: offsetEnd,
      include_actions: true,
      interval: "1d",
      missing_symbols: [],
      prepost: false,
      provider: "yahoo_finance",
      query_fingerprint: "b".repeat(64),
      requested_at: offsetNow,
      requested_symbols: [input.symbol],
      returned_symbols: [input.symbol],
      row_count: bars.length,
      schema_version: "research-bars-v1",
      served_at: offsetNow,
      source: "yfinance",
      start: offsetStart,
    },
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  return {
    schema_version: "mdp-yfinance-research-observations-v1",
    provider: "yfinance",
    source: "Yahoo Finance",
    asset_class: input.assetClass,
    resolution: "1d",
    requested_adjustment: input.adjustment,
    provider_adjustment_semantics: "unknown_or_provider_native",
    adjustment_confirmed_raw: false,
    numeric_encoding: "binary_float_projection",
    canonical: false,
    point_in_time: false,
    executable: false,
    display_only: true,
    mdp_coverage_asserted: false,
    requested_symbols: [input.symbol],
    requested_range: {
      start_utc: new Date(input.startMs).toISOString(),
      end_utc: new Date(input.endMs).toISOString(),
      semantics: "start_inclusive_end_exclusive",
    },
    page_range: {
      start_utc: pageStart,
      end_utc: pageEnd,
      semantics: "start_inclusive_end_exclusive",
    },
    observation: {
      source_observation_sha256: createHash("sha256").update(payloadBytes).digest("hex"),
      fetched_at_utc: now,
      payload,
    },
    next_cursor: nextCursor,
  };
}

export function createMdpFixtureServer() {
  const secret = process.env.MDP_RESEARCH_JWT_SECRET;
  if (!validSecret(secret))
    throw new Error(
      "MDP_RESEARCH_JWT_SECRET must be an isolated fake fixture key of at least 64 printable characters",
    );
  const calls = new Map();
  let acceptedDelegations = 0;
  let rejectedDelegations = 0;

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://market-data-platform:4452");
    if (url.pathname === "/healthz" && request.method === "GET") {
      return sendJson(response, 200, { status: "ok", fixture: "synthetic-mdp-observation" });
    }
    if (url.pathname === "/__test/counters" && request.method === "GET") {
      return sendJson(response, 200, {
        calls: Object.fromEntries(
          [...calls.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
        acceptedDelegations,
        rejectedDelegations,
        fixture: FIXTURE_LABEL,
      });
    }
    if (url.pathname === "/__test/counters/reset" && request.method === "POST") {
      calls.clear();
      acceptedDelegations = 0;
      rejectedDelegations = 0;
      return sendJson(response, 200, { reset: true });
    }

    if (url.pathname.startsWith("/v1/"))
      calls.set(url.pathname, (calls.get(url.pathname) ?? 0) + 1);
    if (url.pathname !== ROUTE) return sendJson(response, 404, { error: "not_found" });
    if (request.method !== "GET")
      return sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
    if (
      request.headers["content-encoding"] ||
      request.headers["transfer-encoding"] ||
      (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")
    ) {
      return sendJson(response, 400, { error: "invalid_request" });
    }

    const authorization = /^Bearer (.{1,8192})$/u.exec(request.headers.authorization ?? "");
    if (!authorization || !verifyResearchDelegation(authorization[1], secret)) {
      rejectedDelegations += 1;
      return sendJson(response, 401, { error: "invalid_research_delegation" });
    }
    acceptedDelegations += 1;
    const input = readRequest(url);
    if (!input) return sendJson(response, 400, { error: "invalid_query" });
    const observation = syntheticObservation(input);
    if (!observation) return sendJson(response, 422, { error: "unsupported_fixture_page" });
    // The payload preserves the validated provider-native DTO. Synthetic test
    // provenance is explicit in adapter_version; these rows are not Yahoo data.
    return sendJson(response, 200, observation);
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "fixture_internal_error" });
      else response.destroy();
    });
  });
}

function start() {
  const port = Number(process.env.PORT ?? "4452");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const server = createMdpFixtureServer();
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`native synthetic MDP acceptance fixture listening on ${port}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) start();
