import { createServer } from "node:http";
import { randomUUID, webcrypto } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT, decodeProtectedHeader, jwtVerify } from "jose";

const oidcPort = 4310;
const gatewayPort = 4311;
const researchPort = 4312;
const bindHost = process.env.E2E_MOCK_BIND_HOST ?? "127.0.0.1";
const webOrigin = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3300";
const issuer = process.env.E2E_OIDC_ORIGIN ?? `http://127.0.0.1:${oidcPort}`;
const bffKey = "b".repeat(64);
const researchKey = "r".repeat(64);
const researchServiceKey = "research-service-test-key-that-is-at-least-32-bytes";
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
  research: { requests: Object.create(null), authorized: 0, rejected: 0, inFlight: 0 },
};
const gatewayControl = {
  snapshotStatus: 200,
  snapshotFeed: "sip",
  snapshots: null,
  optionStatus: 200,
  optionFeed: "opra",
  contracts: [],
  sseStatus: 200,
  sseEvents: [],
  sseDisconnectAfterMs: null,
  quotes: null,
  previewDelaysMs: [],
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
      sseStatus: 200, sseEvents: [], sseDisconnectAfterMs: null, quotes: null, previewDelaysMs: [],
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
    for (const key of ["snapshotStatus", "snapshotFeed", "snapshots", "optionStatus", "optionFeed", "contracts", "sseStatus", "sseEvents", "sseDisconnectAfterMs", "quotes", "previewDelaysMs"]) {
      if (Object.hasOwn(body, key)) gatewayControl[key] = body[key];
    }
    previewSequence = 0;
    return sendJson(res, 200, { ok: true, config: gatewayControl });
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
  metrics.gateway.calls.push({ method: req.method, path: url.pathname, bearer_present: Boolean(req.headers.authorization) });
  let payload;
  try {
    payload = await verifyGatewayRequest(req);
    metrics.gateway.authorized += 1;
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
  if (url.pathname === "/api/v1/status") {
    return sendJson(res, 200, {
      service: "EqoBoard", market_credentials_present: false,
      stock_feed: "sip", option_feed: "opra", execution_mode: "disabled",
      configured_adapters: [], as_of: new Date().toISOString(),
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
        expires_at: new Date(Date.now() + 60_000).toISOString(),
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
    const rows = requested.map((symbol) => configured?.find((row) => row?.symbol === symbol) ?? {
      symbol,
      source: symbol === "VIX" || symbol === "^VIX" ? "mock-fixture/FRED" : "mock-fixture/SIP",
      asOf: "2026-10-07T12:00:00Z",
      last: 500,
    });
    return sendJson(res, 200, rows);
  }
  if (url.pathname === "/api/status") return sendJson(res, 200, { ok: true, source: "mock-research" });
  return sendJson(res, 200, { path: url.pathname, scope: requiredScope, source: "mock-research" });
});

for (const [server, port] of [[oidc, oidcPort], [gateway, gatewayPort], [research, researchPort]]) {
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, bindHost, resolve));
}
console.log(`E2E mock OIDC/Gateway/research listening on ${oidcPort}/${gatewayPort}/${researchPort}`);

function shutdown() {
  for (const server of [oidc, gateway, research]) server.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
