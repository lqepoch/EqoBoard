#!/usr/bin/env node

/**
 * Isolated CI-only OIDC and Gateway fixtures. This server intentionally has no
 * provider, broker, order, or account connector. The OIDC signing key is
 * generated in memory for each process and the Gateway returns empty,
 * explicitly synthetic/unavailable responses only.
 *
 * Compose runs two copies:
 *   FIXTURE_SERVICE=oidc    PORT=4450 node e2e/fixture-server.mjs
 *   FIXTURE_SERVICE=gateway PORT=4451 node e2e/fixture-server.mjs
 *   PORT=4452 node e2e/mdp-fixture.mjs
 *
 * The test OIDC issuer may receive `EQO_PUBLIC_ORIGINS` as an exact,
 * comma-separated loopback callback allowlist for terminal and research-mode
 * app instances. This fixture-only list never changes application origins.
 */
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OIDC_ISSUER = "http://native-mock-oidc:4450";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_AUTH_TRANSACTIONS = 500;
const MAX_AUTH_CODES = 500;
const MAX_ACCESS_TOKENS = 500;
const FIXTURE_LABEL = "native-e2e synthetic fixture; not provider data";

function sendJson(response, status, body, headers = {}) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(encoded);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function parseJsonSegment(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function sameBytes(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request, maximum = MAX_REQUEST_BYTES) {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > maximum))
    return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required fixture environment variable: ${name}`);
  return value;
}

function validClientSecret(value) {
  return typeof value === "string" && value.length >= 32 && /^[\x21-\x7e]+$/u.test(value);
}

function validCallbackUrl(raw, publicOrigin) {
  try {
    const url = new URL(raw);
    const allowedOrigins = publicOrigin instanceof Set ? publicOrigin : new Set([publicOrigin]);
    return (
      allowedOrigins.has(url.origin) &&
      url.pathname === "/api/auth/callback/eqo-oidc" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function configuredPublicOrigins() {
  const configured = process.env.EQO_PUBLIC_ORIGINS;
  const rawOrigins =
    configured === undefined
      ? [requiredEnv("EQO_PUBLIC_ORIGIN")]
      : configured.split(",").map((value) => value.trim());
  if (
    rawOrigins.length < 1 ||
    rawOrigins.length > 4 ||
    rawOrigins.some((value) => value.length === 0)
  ) {
    throw new Error(
      "EQO_PUBLIC_ORIGINS must be a comma-separated list of one to four exact loopback origins",
    );
  }
  const origins = new Set();
  for (const raw of rawOrigins) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("OIDC fixture callback origins must be exact HTTP loopback origins");
    }
    if (
      parsed.origin !== raw ||
      parsed.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new Error("OIDC fixture callback origins must be exact HTTP loopback origins");
    }
    origins.add(parsed.origin);
  }
  if (origins.size !== rawOrigins.length)
    throw new Error("EQO_PUBLIC_ORIGINS must not contain duplicates");
  return origins;
}

function boundedString(value, maximum = 1_024) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !containsControlCharacters(value)
  );
}

function containsControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function validS256(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/u.test(value);
}

function createOidcServer() {
  const issuer = process.env.EQO_OIDC_ISSUER?.trim() || OIDC_ISSUER;
  if (issuer !== OIDC_ISSUER) throw new Error(`OIDC fixture issuer must be ${OIDC_ISSUER}`);
  const clientId = requiredEnv("EQO_OIDC_CLIENT_ID");
  const clientSecret = requiredEnv("EQO_OIDC_CLIENT_SECRET");
  const publicOrigins = configuredPublicOrigins();
  if (!validClientSecret(clientSecret))
    throw new Error(
      "OIDC fixture client secret must be a non-empty fake secret of at least 32 printable characters",
    );

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
    publicExponent: 0x10001,
  });
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: "native-e2e-rs256",
    use: "sig",
  };
  const transactions = new Map();
  const codes = new Map();
  const accessTokens = new Map();

  function prune(map, maximumAgeMs, maximumCount) {
    const cutoff = Date.now() - maximumAgeMs;
    for (const [key, value] of map) {
      if (value.createdAt < cutoff) map.delete(key);
    }
    while (map.size > maximumCount) map.delete(map.keys().next().value);
  }

  function signedIdToken(user, nonce) {
    const now = Math.floor(Date.now() / 1_000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: user.subject,
        aud: clientId,
        iat: now,
        exp: now + 300,
        nonce,
        name: user.name,
        email: user.email,
        email_verified: true,
        roles: user.roles,
      }),
    ).toString("base64url");
    const signingInput = `${header}.${claims}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
      "base64url",
    );
    return `${signingInput}.${signature}`;
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return sendJson(response, 200, { status: "ok", fixture: "oidc" });
    }
    if (url.pathname === "/.well-known/openid-configuration" && request.method === "GET") {
      return sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "profile", "email"],
        claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce", "name", "email", "roles"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks" && request.method === "GET")
      return sendJson(response, 200, { keys: [publicJwk] });
    if (url.pathname === "/authorize" && request.method === "GET") {
      const requestState = {
        clientId: url.searchParams.get("client_id"),
        redirectUri: url.searchParams.get("redirect_uri"),
        responseType: url.searchParams.get("response_type"),
        scope: url.searchParams.get("scope") ?? "",
        state: url.searchParams.get("state"),
        nonce: url.searchParams.get("nonce"),
        codeChallenge: url.searchParams.get("code_challenge"),
        codeChallengeMethod: url.searchParams.get("code_challenge_method"),
      };
      const valid =
        requestState.clientId === clientId &&
        requestState.responseType === "code" &&
        requestState.scope.split(/\s+/u).includes("openid") &&
        boundedString(requestState.state) &&
        boundedString(requestState.nonce) &&
        validS256(requestState.codeChallenge) &&
        requestState.codeChallengeMethod === "S256" &&
        validCallbackUrl(requestState.redirectUri, publicOrigins);
      if (!valid) return sendText(response, 400, "Invalid OIDC authorization request.");
      prune(transactions, 5 * 60_000, MAX_AUTH_TRANSACTIONS);
      if (transactions.size >= MAX_AUTH_TRANSACTIONS)
        return sendText(response, 429, "Too many pending fixture sign-ins.");
      const transactionId = randomBytes(24).toString("base64url");
      transactions.set(transactionId, { ...requestState, createdAt: Date.now() });
      const tx = escapeHtml(transactionId);
      return sendHtml(
        response,
        200,
        `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CI identity fixture</title>
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#172033}button{display:block;width:100%;margin:.8rem 0;padding:.9rem;border:1px solid #94a3b8;border-radius:.5rem;background:#fff;color:inherit;font:inherit;cursor:pointer}</style></head>
<body><main><h1>CI-only identity fixture</h1><p>Select a deterministic test identity. This isolated issuer issues short-lived signed test claims only.</p>
<form action="/authorize/choose" method="post"><input type="hidden" name="transaction" value="${tx}">
<button data-testid="mock-login-reader" name="identity" value="reader" type="submit">Sign in as reader</button>
<button data-testid="mock-login-writer" name="identity" value="writer" type="submit">Sign in as writer</button>
<button data-testid="mock-login-workspace-only" name="identity" value="workspace-only" type="submit">Sign in as workspace-only</button></form></main></body></html>`,
      );
    }
    if (url.pathname === "/authorize/choose" && request.method === "POST") {
      if (
        request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded"
      ) {
        return sendText(response, 415, "Expected an identity-fixture form.");
      }
      const body = await readBody(request, 4 * 1024);
      if (!body) return sendText(response, 413, "Identity-fixture form is too large.");
      const form = new URLSearchParams(body.toString("utf8"));
      const transactionId = form.get("transaction") ?? "";
      const identity = form.get("identity");
      const transaction = transactions.get(transactionId);
      transactions.delete(transactionId);
      if (
        !transaction ||
        Date.now() - transaction.createdAt > 5 * 60_000 ||
        !["reader", "writer", "workspace-only"].includes(identity)
      ) {
        return sendText(response, 400, "Identity selection expired or invalid.");
      }
      const user =
        identity === "writer"
          ? {
              subject: "native-e2e-writer",
              name: "Native E2E Writer",
              email: "writer@native-e2e.invalid",
              roles: ["eqoboard-market-reader", "eqoboard-workspace-editor"],
            }
          : identity === "workspace-only"
            ? {
                subject: "native-e2e-workspace-only",
                name: "Native E2E Workspace Only",
                email: "workspace-only@native-e2e.invalid",
                roles: ["eqoboard-workspace-editor"],
              }
            : {
                subject: "native-e2e-reader",
                name: "Native E2E Reader",
                email: "reader@native-e2e.invalid",
                roles: ["eqoboard-market-reader"],
              };
      prune(codes, 5 * 60_000, MAX_AUTH_CODES);
      if (codes.size >= MAX_AUTH_CODES)
        return sendText(response, 429, "Too many pending fixture authorizations.");
      const code = randomBytes(32).toString("base64url");
      codes.set(code, {
        user,
        nonce: transaction.nonce,
        redirectUri: transaction.redirectUri,
        clientId: transaction.clientId,
        codeChallenge: transaction.codeChallenge,
        createdAt: Date.now(),
      });
      const callback = new URL(transaction.redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", transaction.state);
      response.writeHead(303, {
        location: callback.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      if (
        request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded"
      ) {
        return sendJson(response, 415, { error: "invalid_request" });
      }
      const body = await readBody(request, 8 * 1024);
      if (!body) return sendJson(response, 413, { error: "invalid_request" });
      const form = new URLSearchParams(body.toString("utf8"));
      let basicClientId = "";
      let basicClientSecret = "";
      const authorization = request.headers.authorization ?? "";
      if (authorization.startsWith("Basic ")) {
        try {
          const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
          const separator = decoded.indexOf(":");
          if (separator >= 0) {
            basicClientId = decodeURIComponent(decoded.slice(0, separator));
            basicClientSecret = decodeURIComponent(decoded.slice(separator + 1));
          }
        } catch {
          return sendJson(
            response,
            401,
            { error: "invalid_client" },
            { "www-authenticate": 'Basic realm="native-e2e-oidc"' },
          );
        }
      }
      const submittedClientId = form.get("client_id") ?? basicClientId;
      const submittedClientSecret = form.get("client_secret") ?? basicClientSecret;
      if (
        submittedClientId !== clientId ||
        !sameBytes(submittedClientSecret, clientSecret) ||
        form.get("grant_type") !== "authorization_code"
      ) {
        return sendJson(
          response,
          401,
          { error: "invalid_client" },
          { "www-authenticate": 'Basic realm="native-e2e-oidc"' },
        );
      }
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const authorizationCode = codes.get(code);
      codes.delete(code);
      if (
        !authorizationCode ||
        Date.now() - authorizationCode.createdAt > 5 * 60_000 ||
        authorizationCode.clientId !== clientId ||
        authorizationCode.redirectUri !== redirectUri ||
        !validCallbackUrl(redirectUri, publicOrigins) ||
        !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
      ) {
        return sendJson(response, 400, { error: "invalid_grant" });
      }
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!sameBytes(challenge, authorizationCode.codeChallenge))
        return sendJson(response, 400, { error: "invalid_grant" });
      const accessToken = randomBytes(32).toString("base64url");
      accessTokens.set(accessToken, { user: authorizationCode.user, createdAt: Date.now() });
      prune(accessTokens, 5 * 60_000, MAX_ACCESS_TOKENS);
      return sendJson(response, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 300,
        scope: "openid profile email",
        id_token: signedIdToken(authorizationCode.user, authorizationCode.nonce),
      });
    }
    if (url.pathname === "/userinfo" && request.method === "GET") {
      const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(request.headers.authorization ?? "");
      const record = match ? accessTokens.get(match[1]) : undefined;
      if (!record || Date.now() - record.createdAt > 5 * 60_000)
        return sendJson(response, 401, { error: "invalid_token" });
      return sendJson(response, 200, {
        sub: record.user.subject,
        name: record.user.name,
        email: record.user.email,
        email_verified: true,
        roles: record.user.roles,
      });
    }
    if (
      url.pathname.startsWith("/authorize") ||
      url.pathname === "/token" ||
      url.pathname === "/userinfo"
    ) {
      return sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET, POST" });
    }
    return sendJson(response, 404, { error: "not_found" });
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "fixture_internal_error" });
      else response.destroy();
    });
  });
}

const GATEWAY_ROUTES = new Map([
  ["/api/v1/status", { method: "GET", permission: "market:read" }],
  ["/api/v1/stocks/snapshots", { method: "GET", permission: "market:read" }],
  ["/api/v1/stocks/bars", { method: "GET", permission: "market:read" }],
  ["/api/v1/options/chain", { method: "GET", permission: "market:read" }],
  ["/api/v1/subscriptions/stocks", { method: "POST", permission: "market:subscribe" }],
  ["/api/v1/subscriptions/options", { method: "POST", permission: "market:subscribe" }],
  ["/api/v1/orders/preview", { method: "POST", permission: "orders:preview" }],
  ["/api/v1/stream/sse", { method: "GET", permission: "market:stream" }],
]);

function verifyGatewayToken(raw, expectedPermission) {
  if (typeof raw !== "string" || raw.length > 8_192) return false;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return false;
  const header = parseJsonSegment(parts[0]);
  const claims = parseJsonSegment(parts[1]);
  if (
    !header ||
    !claims ||
    header.alg !== "HS256" ||
    header.typ !== "JWT" ||
    (header.kid !== "bff" && header.kid !== "research")
  )
    return false;
  const secretName = header.kid === "bff" ? "EQO_GATEWAY_JWT_SECRET" : "EQO_RESEARCH_JWT_SECRET";
  const secret = process.env[secretName];
  if (
    !validClientSecret(secret) ||
    !sameBytes(
      createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest(),
      Buffer.from(parts[2], "base64url"),
    )
  )
    return false;
  const issuer = header.kid === "bff" ? "eqoboard-openterminal" : "openterminal-research";
  const now = Math.floor(Date.now() / 1_000);
  const scopes = Array.isArray(claims.scope) ? claims.scope : [];
  return (
    claims.iss === issuer &&
    claims.aud === "eqoboard-gateway" &&
    claims.idp_iss === OIDC_ISSUER &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    typeof claims.jti === "string" &&
    typeof claims.iat === "number" &&
    claims.iat <= now + 30 &&
    typeof claims.exp === "number" &&
    claims.exp > now &&
    claims.exp - claims.iat <= 60 &&
    scopes.length === 1 &&
    scopes[0] === expectedPermission
  );
}

function fixtureEnvelope(extra = {}) {
  return {
    schemaVersion: 1,
    source_mode: "test-fixture",
    source_label: FIXTURE_LABEL,
    gateway_instance_id: "native-e2e-fixture",
    received_at: new Date().toISOString(),
    ...extra,
  };
}

function readGatewayBody(request) {
  return readBody(request, MAX_REQUEST_BYTES).then((body) => {
    if (!body) return null;
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }
  });
}

function createGatewayServer() {
  const calls = new Map();
  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://native-mock-gateway:4451");
    if (url.pathname === "/healthz" && request.method === "GET")
      return sendJson(response, 200, { status: "ok", fixture: "gateway" });
    if (url.pathname === "/__test/counters" && request.method === "GET") {
      return sendJson(response, 200, {
        calls: Object.fromEntries(
          [...calls.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
      });
    }
    if (url.pathname === "/__test/counters/reset" && request.method === "POST") {
      calls.clear();
      return sendJson(response, 200, { reset: true });
    }

    // Count every application API dispatch, including an unknown path. This
    // lets an isolated anonymous test detect accidental proxy calls that the
    // current fixture route allowlist does not recognize.
    if (url.pathname.startsWith("/api/v1/")) {
      calls.set(url.pathname, (calls.get(url.pathname) ?? 0) + 1);
    }
    const route = GATEWAY_ROUTES.get(url.pathname);
    if (!route) return sendJson(response, 404, { error: "not_found" });
    if (request.method !== route.method)
      return sendJson(response, 405, { error: "method_not_allowed" }, { allow: route.method });
    const authorization = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "");
    if (!authorization || !verifyGatewayToken(authorization[1], route.permission)) {
      return sendJson(response, 401, { error: "invalid_delegation" });
    }

    if (url.pathname === "/api/v1/stream/sse") {
      // Keep the authenticated transport open without publishing any market
      // event. A comment frame lets EventSource establish the connection but
      // cannot be mistaken for a quote, trade, bar, or depth update.
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      response.write(": native-e2e empty stream; no market events\n\n");
      return;
    }

    if (route.method === "POST") {
      const body = await readGatewayBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body))
        return sendJson(response, 400, { error: "invalid_fixture_request" });
      if (url.pathname === "/api/v1/orders/preview") {
        return sendJson(
          response,
          503,
          fixtureEnvelope({
            status: "unavailable",
            reason: "no broker or order preview provider is connected to the CI fixture",
          }),
        );
      }
      return sendJson(
        response,
        200,
        fixtureEnvelope({
          status: "unsupported",
          reason: "no market provider is connected to the CI fixture",
        }),
      );
    }

    if (url.pathname === "/api/v1/stocks/snapshots") {
      return sendJson(response, 200, fixtureEnvelope({ feed: "fixture", snapshots: [] }));
    }
    if (url.pathname === "/api/v1/stocks/bars") {
      return sendJson(
        response,
        200,
        fixtureEnvelope({ symbol: null, timeframe: "1Day", feed: "fixture", bars: [] }),
      );
    }
    if (url.pathname === "/api/v1/options/chain") {
      return sendJson(
        response,
        200,
        fixtureEnvelope({ underlying: null, expiration: null, feed: "fixture", contracts: [] }),
      );
    }
    return sendJson(
      response,
      200,
      fixtureEnvelope({
        status: "unavailable",
        reason: "no market provider is connected to the CI fixture",
        feeds: { stocks: "unknown", options: "unknown" },
      }),
    );
  }
  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "fixture_internal_error" });
      else response.destroy();
    });
  });
}

function start() {
  const service = process.env.FIXTURE_SERVICE;
  const defaultPort = service === "oidc" ? "4450" : "4451";
  const port = Number(process.env.PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("PORT must be an integer from 1 to 65535");
  if (service !== "oidc" && service !== "gateway")
    throw new Error("FIXTURE_SERVICE must be oidc or gateway");
  const server = service === "oidc" ? createOidcServer() : createGatewayServer();
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`native ${service} acceptance fixture listening on ${port}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) start();
