import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.E2E_OIDC_PORT ?? 4310);
const controlToken = process.env.E2E_OIDC_CONTROL_TOKEN ?? "";
const issuer = process.env.E2E_OIDC_ISSUER ?? `http://127.0.0.1:${port}`;
const clientId = process.env.E2E_OIDC_CLIENT_ID ?? "eqo-openbb-e2e";
const clientSecret = process.env.E2E_OIDC_CLIENT_SECRET ?? "";
const allowedCallback = process.env.E2E_OIDC_CALLBACK ?? "http://127.0.0.1:8088/api/auth/callback/eqo-oidc";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
publicJwk.kid = `e2e-${clientId}`;
publicJwk.use = "sig";
publicJwk.alg = "RS256";
const authCodes = new Map();
let roles = ["eqoboard-market-reader"];
const metrics = { authorization_count: 0, token_count: 0, client_id: clientId };

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readText(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error("request too large");
  }
  return body;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signIdToken({ nonce }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuer,
    aud: clientId,
    sub: "openbb-subject-e2e",
    iat: now,
    exp: now + 300,
    nonce,
    name: "OpenBB E2E Reader",
    email: "openbb-reader@example.com",
    roles,
  }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  if (url.pathname === "/__test/healthz" && req.method === "GET") return json(res, 200, { status: "ok" });
  const testControlPath = ["/__test/metrics", "/__test/reset", "/__test/roles"].includes(url.pathname);
  if (testControlPath && (!controlToken || req.headers["x-e2e-control"] !== controlToken)) {
    return json(res, 404, { error: "not_found" });
  }
  if (url.pathname === "/__test/metrics" && req.method === "GET") return json(res, 200, metrics);
  if (url.pathname === "/__test/reset" && req.method === "POST") {
    roles = ["eqoboard-market-reader"];
    metrics.authorization_count = 0;
    metrics.token_count = 0;
    authCodes.clear();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__test/roles" && req.method === "POST") {
    try {
      const body = JSON.parse(await readText(req) || "{}");
      if (!Array.isArray(body.roles) || body.roles.some((role) => typeof role !== "string")) {
        return json(res, 400, { error: "roles_required" });
      }
      roles = [...body.roles];
      return json(res, 200, { roles });
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
  }
  if (url.pathname === "/.well-known/openid-configuration" && req.method === "GET") {
    return json(res, 200, {
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
  if (url.pathname === "/jwks" && req.method === "GET") return json(res, 200, { keys: [publicJwk] });
  if (url.pathname === "/authorize" && req.method === "GET") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    if (
      url.searchParams.get("client_id") !== clientId ||
      url.searchParams.get("response_type") !== "code" ||
      !url.searchParams.get("scope")?.split(" ").includes("openid") ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      redirectUri !== allowedCallback || !state || !challenge
    ) {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("invalid authorization request");
    }
    const code = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    authCodes.set(code, {
      redirectUri,
      challenge,
      nonce: url.searchParams.get("nonce"),
      expiresAt: Date.now() + 30_000,
    });
    metrics.authorization_count += 1;
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    res.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let form;
    try {
      form = new URLSearchParams(await readText(req));
    } catch {
      return json(res, 400, { error: "invalid_request" });
    }
    const basic = req.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":")
      : [];
    const submittedClientId = basic[0] ?? form.get("client_id");
    const submittedSecret = basic[1] ?? form.get("client_secret");
    const code = form.get("code") ?? "";
    const saved = authCodes.get(code);
    authCodes.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      submittedClientId !== clientId || submittedSecret !== clientSecret || !saved ||
      saved.expiresAt <= Date.now() || saved.redirectUri !== form.get("redirect_uri") ||
      challenge !== saved.challenge
    ) return json(res, 400, { error: "invalid_grant" });
    metrics.token_count += 1;
    return json(res, 200, {
      access_token: "openbb-e2e-idp-access-token-only",
      token_type: "Bearer",
      expires_in: 300,
      id_token: signIdToken({ nonce: saved.nonce }),
    });
  }
  if (url.pathname === "/userinfo" && req.method === "GET") {
    return json(res, 200, { sub: "openbb-subject-e2e", roles });
  }
  res.writeHead(404).end();
});

server.listen(port, "0.0.0.0");
