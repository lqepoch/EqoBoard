import { createServer } from "node:http";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, decodeProtectedHeader, jwtVerify } from "jose";

const oidcPort = Number(process.env.E2E_OIDC_PORT ?? 4310);
const gatewayPort = Number(process.env.E2E_GATEWAY_PORT ?? 4311);
const researchPort = Number(process.env.E2E_RESEARCH_PORT ?? 4312);
const mdpPort = Number(process.env.E2E_MDP_PORT ?? 4313);
const quantPort = Number(process.env.E2E_QUANT_PORT ?? 4314);
const enginePort = Number(process.env.E2E_ENGINE_PORT ?? 4315);
const bindHost = process.env.E2E_MOCK_BIND_HOST ?? "127.0.0.1";
const webOrigin = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3300";
const issuer = process.env.E2E_OIDC_ORIGIN ?? `http://127.0.0.1:${oidcPort}`;
const bffKey = "b".repeat(64);
const researchKey = "r".repeat(64);
const researchServiceKey = "research-service-test-key-that-is-at-least-32-bytes";
const mdpTerminalKey = "m".repeat(64);
const mdpResearchKey = "q".repeat(64);
const quantTerminalKey = "t".repeat(64);
const quantResearchKey = "u".repeat(64);
const engineTerminalKey = "e".repeat(64);
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "test-oidc-key";
publicJwk.use = "sig";
publicJwk.alg = "RS256";

const authCodes = new Map();
let roles = ["eqoboard-market-reader"];
let issueExpiredIdToken = false;
const metrics = {
  gateway: {
    requests: Object.create(null), authorized: 0, rejected: 0, streamOpened: 0, streamClosed: 0,
    activeStreams: 0, inFlight: 0, calls: [], subscriptions: [], previews: [],
  },
  research: { requests: Object.create(null), authorized: 0, rejected: 0, inFlight: 0, calls: [] },
  mdp: { requests: Object.create(null), authorized: 0, rejected: 0, inFlight: 0, calls: [] },
  quant: { requests: Object.create(null), authorized: 0, rejected: 0, inFlight: 0, calls: [] },
  engine: { requests: Object.create(null), authorized: 0, rejected: 0, inFlight: 0, calls: [] },
};
const mdpControl = {
  status: 200,
  response: null,
  contentType: "application/json",
  cacheControl: "no-store",
  location: null,
  bodyBytes: 0,
  delayMs: 0,
};
const quantControl = {
  status: 200, response: null, location: null, delayMs: 0, finiteReceiptBinding: "UNKNOWN",
  protoJsonText: null, publicProjectionBase64: null, publicProjectionSha256: null, factorFeatureSummary: null,
};
const defaultEngineStatus = readFileSync(
  new URL("./fixtures/engine-status-response-v1.json", import.meta.url),
  "utf8",
);
const defaultEnginePreview = readFileSync(
  new URL("./fixtures/synthetic-offline-preview-v1.json", import.meta.url),
  "utf8",
);
const engineControl = {
  statusCode: 200, previewCode: 200, statusText: defaultEngineStatus, previewText: defaultEnginePreview,
  statusContentType: "application/json", previewContentType: "application/json",
  statusLocation: null, previewLocation: null, statusBodyBytes: 0, previewBodyBytes: 0, delayMs: 0,
};
const defaultQuantProtoJson = readFileSync(
  new URL("./fixtures/prediction-envelope-v1.synthetic.protojson", import.meta.url),
  "utf8",
);
const gatewayControl = {
  snapshotStatus: 200,
  snapshotFeed: "sip",
  snapshots: null,
  optionStatus: 200,
  optionFeed: "opra",
  contracts: [],
  openbbStocksStatus: 200,
  openbbBarsStatus: 200,
  openbbOptionsStatus: 200,
  openbbOptionsTruncated: false,
  sseStatus: 200,
  sseEvents: [],
  sseDisconnectAfterMs: null,
  quotes: null,
  previewDelaysMs: [],
  previewTtlMs: 60_000,
};
let previewSequence = 0;

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.byteLength, "cache-control": "no-store" });
  res.end(data);
}

function countRequest(service, path) {
  service.requests[path] = (service.requests[path] ?? 0) + 1;
}

function trackResponse(service, response) {
  service.inFlight += 1;
  let completed = false;
  const settle = () => {
    if (completed) return;
    completed = true;
    service.inFlight = Math.max(0, service.inFlight - 1);
  };
  response.once("finish", settle);
  response.once("close", settle);
}

async function readJson(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

async function readText(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function authorizeCode(req, res, url) {
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  if (
    url.searchParams.get("client_id") !== "eqo-test" ||
    url.searchParams.get("response_type") !== "code" ||
    !url.searchParams.get("scope")?.split(" ").includes("openid") ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !redirectUri || !state || !challenge
  ) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("invalid authorization request");
    return;
  }
  const code = randomUUID();
  authCodes.set(code, {
    redirectUri,
    challenge,
    nonce: url.searchParams.get("nonce"),
    roles: [...roles],
    expiresAt: Date.now() + 30_000,
    expiredIdToken: issueExpiredIdToken,
  });
  issueExpiredIdToken = false;
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  res.writeHead(302, { location: callback.toString() });
  res.end();
}

const oidc = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  if (url.pathname === "/.well-known/openid-configuration") {
    return sendJson(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.pathname === "/jwks") return sendJson(res, 200, { keys: [publicJwk] });
  if (url.pathname === "/authorize" && req.method === "GET") return authorizeCode(req, res, url);
  if (url.pathname === "/token" && req.method === "POST") {
    const form = new URLSearchParams(await readText(req));
    const basic = req.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":")
      : [];
    const clientId = basic[0] ?? form.get("client_id");
    const clientSecret = basic[1] ?? form.get("client_secret");
    const code = form.get("code") ?? "";
    const saved = authCodes.get(code);
    authCodes.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    const computed = base64url(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    if (
      clientId !== "eqo-test" || clientSecret !== "test-secret" || !saved ||
      saved.expiresAt <= Date.now() || saved.redirectUri !== form.get("redirect_uri") ||
      computed !== saved.challenge
    ) return sendJson(res, 400, { error: "invalid_grant" });

    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      nonce: saved.nonce,
      name: "E2E User",
      email: "e2e@example.test",
      roles: saved.roles,
    })
      .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience("eqo-test")
      .setSubject("subject-e2e")
      .setIssuedAt(now)
      .setExpirationTime(now + (saved.expiredIdToken ? -30 : 300))
      .sign(privateKey);
    return sendJson(res, 200, { access_token: "test-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken });
  }
  if (url.pathname === "/userinfo") return sendJson(res, 200, { sub: "subject-e2e", roles });
  if (url.pathname === "/__test/metrics" && req.method === "GET") return sendJson(res, 200, metrics);
  if (url.pathname === "/__test/reset" && req.method === "POST") {
    for (const service of Object.values(metrics)) {
      for (const key of Object.keys(service.requests)) delete service.requests[key];
      service.authorized = 0;
      service.rejected = 0;
      if ("streamOpened" in service) service.streamOpened = 0;
      if ("streamClosed" in service) service.streamClosed = 0;
      if ("calls" in service) service.calls.length = 0;
      if ("subscriptions" in service) service.subscriptions.length = 0;
      if ("previews" in service) service.previews.length = 0;
    }
    previewSequence = 0;
    issueExpiredIdToken = false;
    Object.assign(gatewayControl, {
      snapshotStatus: 200, snapshotFeed: "sip", snapshots: null,
      optionStatus: 200, optionFeed: "opra", contracts: [],
      openbbStocksStatus: 200, openbbBarsStatus: 200, openbbOptionsStatus: 200, openbbOptionsTruncated: false,
      sseStatus: 200, sseEvents: [], sseDisconnectAfterMs: null, quotes: null, previewDelaysMs: [],
      previewTtlMs: 60_000,
    });
    Object.assign(mdpControl, {
      status: 200, response: null, contentType: "application/json", cacheControl: "no-store",
      location: null, bodyBytes: 0, delayMs: 0,
    });
    Object.assign(quantControl, {
      status: 200, response: null, location: null, delayMs: 0, finiteReceiptBinding: "UNKNOWN",
      protoJsonText: null, publicProjectionBase64: null, publicProjectionSha256: null, factorFeatureSummary: null,
    });
    Object.assign(engineControl, {
      statusCode: 200, previewCode: 200, statusText: defaultEngineStatus, previewText: defaultEnginePreview,
      statusContentType: "application/json", previewContentType: "application/json",
      statusLocation: null, previewLocation: null, statusBodyBytes: 0, previewBodyBytes: 0, delayMs: 0,
    });
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/__test/roles" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    if (!Array.isArray(body.roles) || body.roles.some((role) => typeof role !== "string")) {
      return sendJson(res, 400, { error: "roles_required" });
    }
    roles = [...body.roles];
    return sendJson(res, 200, { roles });
  }
  if (url.pathname === "/__test/expire-id-token" && req.method === "POST") {
    issueExpiredIdToken = true;
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/__test/config" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    for (const key of ["snapshotStatus", "snapshotFeed", "snapshots", "optionStatus", "optionFeed", "contracts", "openbbStocksStatus", "openbbBarsStatus", "openbbOptionsStatus", "openbbOptionsTruncated", "sseStatus", "sseEvents", "sseDisconnectAfterMs", "quotes", "previewDelaysMs", "previewTtlMs"]) {
      if (Object.hasOwn(body, key)) gatewayControl[key] = body[key];
    }
    for (const key of ["status", "response", "contentType", "cacheControl", "location", "bodyBytes", "delayMs"]) {
      if (Object.hasOwn(body, `mdp${key[0].toUpperCase()}${key.slice(1)}`)) {
        mdpControl[key] = body[`mdp${key[0].toUpperCase()}${key.slice(1)}`];
      }
    }
    for (const key of [
      "status", "response", "location", "delayMs", "finiteReceiptBinding", "protoJsonText",
      "publicProjectionBase64", "publicProjectionSha256", "factorFeatureSummary",
    ]) {
      if (Object.hasOwn(body, `quant${key[0].toUpperCase()}${key.slice(1)}`)) {
        quantControl[key] = body[`quant${key[0].toUpperCase()}${key.slice(1)}`];
      }
    }
    for (const key of ["statusCode", "previewCode", "statusText", "previewText", "statusContentType", "previewContentType", "statusLocation", "previewLocation", "statusBodyBytes", "previewBodyBytes", "delayMs"]) {
      if (Object.hasOwn(body, `engine${key[0].toUpperCase()}${key.slice(1)}`)) {
        engineControl[key] = body[`engine${key[0].toUpperCase()}${key.slice(1)}`];
      }
    }
    previewSequence = 0;
    return sendJson(res, 200, { ok: true, config: gatewayControl, mdp: mdpControl, engine: { ...engineControl, statusText: undefined, previewText: undefined } });
  }
  if (url.pathname === "/evil") {
    const html = `<!doctype html><html><body>external-origin<script>
      fetch('${webOrigin}/api/eqo/stocks/subscribe', {
        method: 'POST', mode: 'no-cors', credentials: 'include',
        headers: { 'content-type': 'text/plain' }, body: '{"consumer_id":"forged","symbols":[]}'
      }).catch(() => {});
    </script></body></html>`;
    res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(html) });
    return res.end(html);
  }
  res.writeHead(404).end();
});

async function verifyGatewayRequest(req) {
  const raw = req.headers.authorization ?? "";
  if (!raw.startsWith("Bearer ")) throw new Error("bearer required");
  const token = raw.slice("Bearer ".length);
  const header = decodeProtectedHeader(token);
  if (header.alg !== "HS256") throw new Error("algorithm rejected");
  const research = header.kid === "research";
  if (!research && header.kid !== "bff") throw new Error("kid rejected");
  const secret = research ? researchKey : bffKey;
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: research ? "openterminal-research" : "eqoboard-openterminal",
    audience: "eqoboard-gateway",
  });
  if (!Array.isArray(payload.scope) || payload.scope.length === 0 || payload.scope.some((scope) => typeof scope !== "string")) {
    throw new Error("scope rejected");
  }
  if (research && (payload.scope.length !== 1 || payload.scope[0] !== "market:read")) {
    throw new Error("research scope rejected");
  }
  return payload;
}

const gateway = createServer(async (req, res) => {
  trackResponse(metrics.gateway, res);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${gatewayPort}`);
  countRequest(metrics.gateway, url.pathname);
  metrics.gateway.calls.push({
    method: req.method,
    path: url.pathname,
    symbol: url.searchParams.get("symbol"),
    symbols: url.searchParams.get("symbols"),
    underlying: url.searchParams.get("underlying"),
    expiration: url.searchParams.get("expiration"),
    timeframe: url.searchParams.get("timeframe"),
    days: url.searchParams.get("days"),
    limit: url.searchParams.get("limit"),
    bearer_present: Boolean(req.headers.authorization),
  });
  if (req.method === "GET" && url.pathname === "/widgets.json") {
    return sendJson(res, 200, {
      eqo_sip_watchlist: { name: "EqoBoard SIP Stock Quotes", endpoint: "openbb/v1/stocks", type: "table" },
      eqo_opra_contracts: { name: "EqoBoard OPRA Option Chain", endpoint: "openbb/v1/options", type: "table" },
      eqo_sip_bars: { name: "EqoBoard SIP OHLCV", endpoint: "openbb/v1/bars", type: "table" },
    });
  }
  if (req.method === "GET" && url.pathname === "/apps.json") {
    return sendJson(res, 200, [{ name: "EqoBoard SIP + OPRA Research", tabs: {} }]);
  }
  let payload;
  try {
    payload = await verifyGatewayRequest(req);
    metrics.gateway.authorized += 1;
    const observed = metrics.gateway.calls.at(-1);
    observed.subject = payload.sub;
    observed.scope = payload.scope;
    observed.issuer = payload.iss;
    observed.audience = payload.aud;
    observed.iat = payload.iat;
    observed.exp = payload.exp;
    observed.kid = decodeProtectedHeader(req.headers.authorization.slice("Bearer ".length)).kid;
  } catch {
    metrics.gateway.rejected += 1;
    return sendJson(res, 401, { error: "unauthorized" });
  }
  const scopes = payload.scope;
  const required = url.pathname.includes("/orders/preview") ? "orders:preview"
    : url.pathname.includes("/orders/submit") ? "paper:submit"
    : url.pathname.includes("/subscriptions/") ? "market:subscribe"
    : url.pathname.includes("/stream/") || url.pathname.includes("auth/ws-ticket") ? "market:stream"
    : "market:read";
  if (!scopes.includes(required)) return sendJson(res, 403, { error: "forbidden" });
  if (url.pathname === "/openbb/v1/stocks") {
    if (gatewayControl.openbbStocksStatus !== 200) return sendJson(res, gatewayControl.openbbStocksStatus, { error: "sip_unavailable" });
    const symbols = (url.searchParams.get("symbols") ?? "QQQ,SPY,NVDA").split(",");
    return sendJson(res, 200, symbols.map((symbol) => ({
      symbol, last: 500, bid: 499.99, ask: 500.01, volume: 1000,
      updated_at: "2026-10-07T12:00:00Z", feed: "sip",
    })));
  }
  if (url.pathname === "/openbb/v1/bars") {
    if (gatewayControl.openbbBarsStatus !== 200) return sendJson(res, gatewayControl.openbbBarsStatus, { error: "sip_unavailable" });
    return sendJson(res, 200, [{
      symbol: url.searchParams.get("symbol"), time: "2026-10-07T12:00:00Z",
      open: 499, high: 501, low: 498, close: 500, volume: 1000, feed: "sip",
    }]);
  }
  if (url.pathname === "/openbb/v1/options") {
    if (gatewayControl.openbbOptionsStatus !== 200) return sendJson(res, gatewayControl.openbbOptionsStatus, { error: "opra_unavailable" });
    return sendJson(res, 200, [{
      symbol: "QQQ261009C00500000", underlying: url.searchParams.get("underlying"),
      expiration: url.searchParams.get("expiration"), right: "call", strike: 500,
      bid: 4.99, ask: 5.01, feed: "opra", updated_at: "2026-10-07T12:00:00Z",
      truncated: gatewayControl.openbbOptionsTruncated,
    }]);
  }
  if (url.pathname === "/api/v1/status") {
    return sendJson(res, 200, {
      service: "EqoBoard", market_credentials_present: false,
      stock_feed: "sip", option_feed: "opra", execution_mode: "disabled",
      adapter_endpoints_configured: ["ibkr"],
      broker_capabilities: Object.fromEntries(["alpaca", "ibkr", "schwab"].map((broker) => [broker, {
        paper: { enabled: false, implementation: "disabled" },
        live: { enabled: false, implementation: "disabled" },
      }])),
      as_of: new Date().toISOString(),
    });
  }
  if (url.pathname === "/api/v1/stocks/snapshots") {
    if (gatewayControl.snapshotStatus !== 200) return sendJson(res, gatewayControl.snapshotStatus, { error: "snapshot_unavailable" });
    if (gatewayControl.snapshots) return sendJson(res, 200, gatewayControl.snapshots);
    const symbols = (url.searchParams.get("symbols") ?? "QQQ").split(",");
    return sendJson(res, 200, { feed: gatewayControl.snapshotFeed, as_of: new Date().toISOString(), snapshots: symbols.map((symbol) => ({
      symbol, last: 500, previous_close: 499, change_percent: 0.2, bid: 499.99, ask: 500.01,
      volume: 1000, updated_at: new Date().toISOString(), feed: "sip",
    })) });
  }
  if (url.pathname === "/api/v1/stocks/bars") return sendJson(res, 200, {
    feed: "sip", bars: [{ time: new Date().toISOString(), open: 499, high: 501, low: 498, close: 500, volume: 1000 }],
  });
  if (url.pathname === "/api/v1/options/chain") {
    if (gatewayControl.optionStatus !== 200) return sendJson(res, gatewayControl.optionStatus, { error: "option_chain_unavailable" });
    return sendJson(res, 200, {
      feed: gatewayControl.optionFeed, as_of: new Date().toISOString(), truncated: false, contracts: gatewayControl.contracts,
    });
  }
  if (url.pathname.startsWith("/api/v1/subscriptions/")) {
    metrics.gateway.subscriptions.push({ path: url.pathname, body: await readJson(req).catch(() => ({})), subject: payload.sub });
    return sendJson(res, 200, { active: 1, max: 20, expires_in_seconds: 90 });
  }
  if (url.pathname === "/api/v1/orders/preview") {
    const body = await readJson(req).catch(() => ({}));
    metrics.gateway.previews.push({ sequence: previewSequence, body });
    const delay = gatewayControl.previewDelaysMs[previewSequence] ?? 0;
    previewSequence += 1;
    if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 15_000)));
    return sendJson(res, 200, {
      preview: {
        preview_id: randomUUID(),
        expires_at: new Date(Date.now() + gatewayControl.previewTtlMs).toISOString(),
        estimated_max_loss: 1.00,
        currency: "USD",
        intent: body,
      },
      execution_enabled: false,
    });
  }
  if (url.pathname === "/api/v1/stream/sse") {
    if (gatewayControl.sseStatus !== 200) return sendJson(res, gatewayControl.sseStatus, { error: "stream_unavailable" });
    metrics.gateway.streamOpened += 1;
    metrics.gateway.activeStreams += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify(gatewayControl.sseEvents)}\n\n`);
    const timer = setInterval(() => res.write(`data: ${JSON.stringify(gatewayControl.sseEvents)}\n\n`), 1000);
    let closed = false;
    const closeStream = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (disconnectTimer) clearTimeout(disconnectTimer);
      metrics.gateway.activeStreams = Math.max(0, metrics.gateway.activeStreams - 1);
      metrics.gateway.streamClosed += 1;
    };
    res.on("close", closeStream);
    const disconnectTimer = Number.isFinite(gatewayControl.sseDisconnectAfterMs)
      ? setTimeout(() => res.end(), Math.max(1, gatewayControl.sseDisconnectAfterMs))
      : undefined;
    return;
  }
  return sendJson(res, 404, { error: "not_found" });
});

async function verifyResearchRequest(req) {
  if (req.headers["x-api-key"] !== researchServiceKey) throw new Error("service key rejected");
  const raw = req.headers.authorization ?? "";
  if (!raw.startsWith("Bearer ")) throw new Error("bearer required");
  const token = raw.slice("Bearer ".length);
  const header = decodeProtectedHeader(token);
  if (header.alg !== "HS256" || header.kid !== "research-bff") throw new Error("research BFF signer rejected");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(researchKey), {
    algorithms: ["HS256"], issuer: "eqoboard-openterminal", audience: "openterminal-research",
  });
  if (!Array.isArray(payload.scope) || payload.scope.length !== 1) throw new Error("scope rejected");
  return payload;
}

const research = createServer(async (req, res) => {
  trackResponse(metrics.research, res);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${researchPort}`);
  countRequest(metrics.research, url.pathname);
  metrics.research.calls.push({ method: req.method, path: url.pathname, symbols: url.searchParams.get("symbols") });
  let payload;
  try {
    payload = await verifyResearchRequest(req);
    metrics.research.authorized += 1;
  } catch {
    metrics.research.rejected += 1;
    return sendJson(res, 401, { error: "unauthorized" });
  }
  const root = url.pathname.split("/").filter(Boolean)[1] ?? "";
  const mixedMarket = new Set(["quotes", "history", "macro", "heatmap", "screener", "sectors", "recap", "earnings-history"]);
  const requiredScope = mixedMarket.has(root) ? "market:read"
    : root === "portfolios" ? (req.method === "GET" ? "workspace:read" : "workspace:write")
    : "research:read";
  if (!payload.scope.includes(requiredScope)) return sendJson(res, 403, { error: "forbidden" });
  if (url.pathname === "/api/quotes/binary") {
    const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.byteLength });
    return res.end(bytes);
  }
  if (url.pathname === "/api/quotes") {
    const requested = (url.searchParams.get("symbols") ?? "VIX").split(",").map((symbol) => symbol.trim()).filter(Boolean);
    const configured = Array.isArray(gatewayControl.quotes) ? gatewayControl.quotes : null;
    const crypto = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "LTC", "MATIC"]
      .map((symbol) => `${symbol}-USD`));
    const foreign = /\.(MI|PA|AS|BR|LS|DE|L|MC|SW|ST|CO|HE|OL|TO|AX|HK|T|NS|BO|TW|TWO|KS|KQ|SS|SZ|SI|JK|KL|BK|SA|MX|SN|ME|IS|TA|IL)$/i;
    const rows = requested.map((symbol) => configured?.find((row) => row?.symbol === symbol) ?? {
      symbol,
      source: symbol === "VIX" || symbol === "^VIX" ? "mock-fixture/FRED"
        : crypto.has(symbol) ? "mock-fixture/Binance"
        : foreign.test(symbol) ? "mock-fixture/Yahoo"
        : "mock-fixture/research",
      asOf: "2026-10-07T12:00:00Z",
      last: 500,
    });
    return sendJson(res, 200, rows);
  }
  if (url.pathname === "/api/status") return sendJson(res, 200, { ok: true, source: "mock-research" });
  return sendJson(res, 200, { path: url.pathname, scope: requiredScope, source: "mock-research" });
});

async function verifyMdpRequest(req) {
  const raw = req.headers.authorization ?? "";
  if (!raw.startsWith("Bearer ")) throw new Error("bearer required");
  const token = raw.slice("Bearer ".length);
  const header = decodeProtectedHeader(token);
  if (header.alg !== "HS256" || !["mdp-terminal", "mdp-research"].includes(header.kid)) {
    throw new Error("MDP signer rejected");
  }
  const isResearch = header.kid === "mdp-research";
  const secret = isResearch ? mdpResearchKey : mdpTerminalKey;
  const issuer = isResearch ? "openterminal-research" : "eqoboard-openterminal";
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"], issuer, audience: "lqepoch-market-data",
  });
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== "lqepoch-market-data" || !Array.isArray(payload.scope) ||
      payload.scope.length !== 1 || payload.scope[0] !== "market:read" ||
      typeof payload.sub !== "string" || typeof payload.idp_iss !== "string" ||
      typeof payload.jti !== "string" || typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" || payload.iat > now || payload.exp <= payload.iat ||
      payload.exp - payload.iat > 60) throw new Error("MDP claims rejected");
  return { payload, kid: header.kid };
}

async function verifyQuantRequest(req) {
  const raw = req.headers.authorization ?? "";
  if (!raw.startsWith("Bearer ")) throw new Error("bearer required");
  const token = raw.slice("Bearer ".length);
  const header = decodeProtectedHeader(token);
  if (header.alg !== "HS256" || header.typ !== "JWT" || !["quant-terminal", "quant-research"].includes(header.kid)) {
    throw new Error("Quant signer rejected");
  }
  const isResearch = header.kid === "quant-research";
  const secret = isResearch ? quantResearchKey : quantTerminalKey;
  const issuer = isResearch ? "openterminal-research" : "eqoboard-openterminal";
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"], issuer, audience: "lqepoch-quant-research",
  });
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== "lqepoch-quant-research" || payload.scope !== "research:private-read" ||
      typeof payload.sub !== "string" || typeof payload.idp_iss !== "string" || typeof payload.jti !== "string" ||
      typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.iat > now ||
      payload.exp <= payload.iat || payload.exp - payload.iat > 60) throw new Error("Quant claims rejected");
  return { payload, kid: header.kid };
}

function defaultQuantResponse(runId) {
  const publicBytes = Buffer.from(quantControl.protoJsonText ?? defaultQuantProtoJson, "utf8");
  const projectionBase64 = quantControl.publicProjectionBase64 ?? publicBytes.toString("base64");
  const projectionSha256 = quantControl.publicProjectionSha256 ?? createHash("sha256").update(publicBytes).digest("hex");
  const response = {
    schema_name: "quant-research-registered-prediction-v1",
    authority: "LOCAL_REGISTERED_ROOT",
    read_only: true,
    promotion_allowed: false,
    run_id: runId,
    prediction_status: "HISTORICAL_SIMULATED_EXPIRED",
    source_manifest_sha256: "a".repeat(64),
    private_artifact_sha256: "b".repeat(64),
    public_protojson_base64: projectionBase64,
    public_protojson_sha256: projectionSha256,
    projection_receipt_sha256: "c".repeat(64),
    assessment: {
      lifecycle: "UNKNOWN",
      identity_resolution: "VERIFIED_EXACT_ONLY",
      source_manifest_binding: "EXACT_WHOLE_BYTES",
      finite_receipt_binding: quantControl.finiteReceiptBinding,
      point_in_time: "UNKNOWN_SOURCE_COMPLETENESS",
      promotion_allowed: false,
      reason_codes: ["FINITE_SEAL_RECEIPT_BYTES_MISSING"],
    },
  };
  if (quantControl.factorFeatureSummary !== null) response.factor_feature = quantControl.factorFeatureSummary;
  return response;
}

const quant = createServer(async (req, res) => {
  trackResponse(metrics.quant, res);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${quantPort}`);
  countRequest(metrics.quant, url.pathname);
  const encodedPath = /^\/v1\/research\/predictions\/([^/]+)$/.exec(url.pathname);
  let runId = null;
  if (encodedPath) {
    try {
      const decoded = decodeURIComponent(encodedPath[1]);
      if (encodeURIComponent(decoded) === encodedPath[1] && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/.test(decoded)) {
        runId = decoded;
      }
    } catch {}
  }
  const call = { method: req.method, path: url.pathname, query_present: Boolean(url.search), bearer_present: Boolean(req.headers.authorization) };
  metrics.quant.calls.push(call);
  let verified;
  try {
    if (!runId || req.method !== "GET" || url.search) throw new Error("route rejected");
    verified = await verifyQuantRequest(req);
    metrics.quant.authorized += 1;
  } catch {
    metrics.quant.rejected += 1;
    return sendJson(res, 401, { error: "unauthorized" });
  }
  Object.assign(call, {
    subject: verified.payload.sub,
    scope: verified.payload.scope,
    issuer: verified.payload.iss,
    audience: verified.payload.aud,
    kid: verified.kid,
    issued_at: verified.payload.iat,
    expires_at: verified.payload.exp,
  });
  if (quantControl.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(quantControl.delayMs, 10_000)));
  if (quantControl.location) {
    res.writeHead(quantControl.status, { location: quantControl.location, "cache-control": "no-store" });
    return res.end();
  }
  return sendJson(res, quantControl.status, quantControl.response ?? defaultQuantResponse(runId));
});

function defaultMdpResponse(url) {
  const symbol = url.searchParams.get("symbol") ?? "QQQ";
  const datasetId = url.pathname.split("/")[3] ?? "synthetic-e2e-v1";
  return {
    summary: {
      namespace: "diagnostic",
      dataset_id: datasetId,
      schema_id: "lqepoch.us_equity_trade_bar_1m.v1",
      source: { provider: "synthetic", feed: "synthetic", entitlement: "unknown", numeric_encoding: "decimal_token" },
      row_count: "1",
      returned_rows: "1",
      content_sha256: "0".repeat(64),
      parquet_schema_sha256: "5e761a91d880e0002aeafe6dc2083b7c8a0ff2ba486d5d93582fbb4479146cb0",
      cache_hit: false,
    },
    rows: [{
      schema_version: 1,
      source_provider: "synthetic",
      source_feed: "synthetic",
      source_entitlement: "unknown",
      source_numeric_encoding: "decimal_token",
      symbol,
      bar_start_utc: "2026-10-07T13:30:00Z",
      bar_end_exclusive_utc: "2026-10-07T13:31:00Z",
      available_at_utc: "2026-10-07T13:31:00Z",
      trade_date: "2026-10-07",
      session_id: "synthetic-one-minute-session",
      session_timezone: "UTC",
      session_policy_id: "synthetic-fixed-session-v1",
      session_policy_sha256: "a".repeat(64),
      session_start_utc: "2026-10-07T13:30:00Z",
      session_end_exclusive_utc: "2026-10-07T13:31:00Z",
      window_start_utc: "2026-10-07T13:30:00Z",
      window_end_exclusive_utc: "2026-10-07T13:31:00Z",
      open: "500.00",
      high: "501.00",
      low: "499.00",
      close: "500.50",
      volume: "1",
      trade_count: "1",
      quote_events_excluded: "0",
      source_timestamp_missing_rows: "0",
      sequence_gap_count: "0",
      late_event_count: "0",
      window_expected_minutes: "1",
      window_empty_trade_minutes: "0",
      source_start_utc: "2026-10-07T13:30:30Z",
      source_end_exclusive_utc: "2026-10-07T13:30:30.000000001Z",
      window_input_eof: true,
      source_pages_exhausted: null,
      completion_mode: "synthetic_eof",
      nbbo_input_status: "excluded",
    }],
  };
}

const mdp = createServer(async (req, res) => {
  trackResponse(metrics.mdp, res);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${mdpPort}`);
  countRequest(metrics.mdp, url.pathname);
  const call = {
    method: req.method,
    path: url.pathname,
    dataset_id: url.pathname.split("/")[3] ?? "",
    namespace: url.searchParams.get("namespace"),
    symbol: url.searchParams.get("symbol"),
    bearer_present: Boolean(req.headers.authorization),
  };
  metrics.mdp.calls.push(call);
  if (req.method !== "GET" || !/^\/v1\/datasets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/bars$/.test(url.pathname)) {
    return sendJson(res, 404, { error: "not_found" });
  }
  let verified;
  try {
    verified = await verifyMdpRequest(req);
    metrics.mdp.authorized += 1;
  } catch {
    metrics.mdp.rejected += 1;
    return sendJson(res, 401, { error: "unauthorized" });
  }
  const { payload, kid } = verified;
  Object.assign(call, {
    subject: payload.sub,
    scope: payload.scope,
    issuer: payload.iss,
    audience: payload.aud,
    iat: payload.iat,
    exp: payload.exp,
    kid,
  });
  if (mdpControl.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(mdpControl.delayMs, 130_000)));
  if (mdpControl.location) {
    res.writeHead(mdpControl.status, {
      location: mdpControl.location,
      "cache-control": mdpControl.cacheControl,
      "content-length": "0",
    });
    return res.end();
  }
  let bytes;
  if (Number.isSafeInteger(mdpControl.bodyBytes) && mdpControl.bodyBytes > 0) {
    bytes = Buffer.alloc(mdpControl.bodyBytes, 0x20);
  } else {
    const response = mdpControl.response ?? defaultMdpResponse(url);
    bytes = Buffer.from(JSON.stringify(response));
  }
  res.writeHead(mdpControl.status, {
    "content-type": mdpControl.contentType,
    "content-length": String(bytes.byteLength),
    "cache-control": mdpControl.cacheControl,
  });
  res.end(bytes);
});

async function verifyEngineRequest(req) {
  const raw = req.headers.authorization ?? "";
  if (!raw.startsWith("Bearer ")) throw new Error("bearer required");
  const token = raw.slice("Bearer ".length);
  const header = decodeProtectedHeader(token);
  if (header.alg !== "HS256" || header.typ !== "JWT" || header.kid !== "engine-terminal") {
    throw new Error("Engine signer rejected");
  }
  const { payload } = await jwtVerify(token, new TextEncoder().encode(engineTerminalKey), {
    algorithms: ["HS256"], issuer: "eqoboard-openterminal", audience: "lqepoch-trading-engine",
  });
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== "lqepoch-trading-engine" || payload.scope !== "engine:offline-read" ||
      payload.sub !== "subject-e2e" || payload.idp_iss !== issuer || typeof payload.jti !== "string" ||
      typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.iat > now ||
      payload.exp <= now || payload.exp - payload.iat > 60) throw new Error("Engine claims rejected");
  return { payload, kid: header.kid };
}

const engine = createServer(async (req, res) => {
  trackResponse(metrics.engine, res);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${enginePort}`);
  countRequest(metrics.engine, url.pathname);
  const call = { method: req.method, path: url.pathname, query_present: Boolean(url.search), bearer_present: Boolean(req.headers.authorization) };
  metrics.engine.calls.push(call);
  const resource = url.pathname === "/v1/status" ? "status" : url.pathname === "/v1/preview" ? "preview" : null;
  if (!resource || req.method !== "GET" || url.search) {
    return sendJson(res, 404, { error: "not_found" });
  }
  let verified;
  try {
    verified = await verifyEngineRequest(req);
    metrics.engine.authorized += 1;
  } catch {
    metrics.engine.rejected += 1;
    return sendJson(res, 401, { error: "unauthorized" });
  }
  Object.assign(call, {
    subject: verified.payload.sub, scope: verified.payload.scope, issuer: verified.payload.iss,
    audience: verified.payload.aud, kid: verified.kid, issued_at: verified.payload.iat, expires_at: verified.payload.exp,
  });
  if (engineControl.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(engineControl.delayMs, 10_000)));
  const codeKey = resource === "status" ? "statusCode" : "previewCode";
  const locationKey = resource === "status" ? "statusLocation" : "previewLocation";
  const typeKey = resource === "status" ? "statusContentType" : "previewContentType";
  const textKey = resource === "status" ? "statusText" : "previewText";
  const bytesKey = resource === "status" ? "statusBodyBytes" : "previewBodyBytes";
  if (engineControl[locationKey]) {
    res.writeHead(engineControl[codeKey], { location: engineControl[locationKey], "cache-control": "no-store" });
    return res.end();
  }
  const bytes = Number.isSafeInteger(engineControl[bytesKey]) && engineControl[bytesKey] > 0
    ? Buffer.alloc(engineControl[bytesKey], 0x20)
    : Buffer.from(engineControl[textKey]);
  res.writeHead(engineControl[codeKey], {
    "content-type": engineControl[typeKey], "content-length": String(bytes.byteLength), "cache-control": "no-store",
  });
  return res.end(bytes);
});

for (const [server, port] of [[oidc, oidcPort], [gateway, gatewayPort], [research, researchPort], [mdp, mdpPort], [quant, quantPort], [engine, enginePort]]) {
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, bindHost, resolve));
}
console.log(`E2E mock OIDC/Gateway/research/MDP/Quant/Engine listening on ${oidcPort}/${gatewayPort}/${researchPort}/${mdpPort}/${quantPort}/${enginePort}`);

function shutdown() {
  for (const server of [oidc, gateway, research, mdp, quant, engine]) server.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
