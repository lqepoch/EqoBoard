import express from "express";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import {
  getGatewayAuthorization,
  requireDelegatedPrincipal,
  requireResearchServiceKey,
  requireScopes,
} from "./auth.js";

const researchKey = "r".repeat(64);
const serviceKey = "service-key-that-is-long-enough-for-tests";
const downstream = { calls: 0 };
let server: Server;
let origin: string;

async function bffToken(scope: string, overrides: {
  kid?: string;
  issuer?: string;
  issuedAgo?: number;
  lifetime?: number;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = now - (overrides.issuedAgo ?? 0);
  return new SignJWT({
    idp_iss: "https://identity.example",
    scope: [scope],
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256", kid: overrides.kid ?? "research-bff" })
    .setIssuer(overrides.issuer ?? "eqoboard-openterminal")
    .setAudience("openterminal-research")
    .setSubject("subject-a")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (overrides.lifetime ?? 60))
    .sign(new TextEncoder().encode(researchKey));
}

async function callApi(token?: string, includeServiceKey = true) {
  const headers = new Headers({
    "x-user": "forged-user",
    "x-role": "eqoboard-workspace-editor",
  });
  if (includeServiceKey) headers.set("x-api-key", serviceKey);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${origin}/api/protected`, { headers });
}

beforeAll(async () => {
  process.env.EQO_RESEARCH_JWT_SECRET = researchKey;
  process.env.EQO_RESEARCH_API_KEY = serviceKey;
  const app = express();
  app.get(
    "/api/protected",
    requireResearchServiceKey,
    requireDelegatedPrincipal,
    requireScopes("research:read"),
    (req, res) => {
      downstream.calls += 1;
      res.json({ subject: req.verifiedPrincipal?.subject });
    },
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.EQO_RESEARCH_JWT_SECRET;
  delete process.env.EQO_RESEARCH_API_KEY;
});

describe("Node delegated identity boundary", () => {
  it("requires the service key and a short-lived delegated user token", async () => {
    const unauthenticated = await callApi(undefined);
    expect(unauthenticated.status).toBe(401);
    const withoutServiceKey = await callApi(await bffToken("research:read"), false);
    expect(withoutServiceKey.status).toBe(401);
    const authorized = await callApi(await bffToken("research:read"));
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ subject: "subject-a" });
    expect(downstream.calls).toBe(1);
  });

  it("rejects old static tokens, the wrong signing key/kid, expired tokens, and insufficient scopes", async () => {
    const staticToken = await callApi("static-test-access-token");
    expect(staticToken.status).toBe(401);
    const wrongKid = await callApi(await bffToken("research:read", { kid: "bff" }));
    expect(wrongKid.status).toBe(401);
    const wrongIssuer = await callApi(await bffToken("research:read", { issuer: "openterminal-research" }));
    expect(wrongIssuer.status).toBe(401);
    const expired = await callApi(await bffToken("research:read", { issuedAgo: 60, lifetime: 50 }));
    expect(expired.status).toBe(401);
    const malformedTime = await callApi(await bffToken("research:read", { issuedAgo: 60, lifetime: 30 }));
    expect(malformedTime.status).toBe(401);
    const forbidden = await callApi(await bffToken("market:read"));
    expect(forbidden.status).toBe(403);
    expect(downstream.calls).toBe(1);
  });

  it("mints a research-key child token limited to the requested market scope", async () => {
    const token = await getGatewayAuthorization({
      subject: "subject-a",
      identityIssuer: "https://identity.example",
      ownerId: "owner-hash",
      scopes: ["market:read"],
    }, "market:read");
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(researchKey), {
      algorithms: ["HS256"],
      issuer: "openterminal-research",
      audience: "eqoboard-gateway",
    });
    expect(protectedHeader.kid).toBe("research");
    expect(payload.scope).toEqual(["market:read"]);
    await expect(getGatewayAuthorization({
      subject: "subject-a",
      identityIssuer: "https://identity.example",
      ownerId: "owner-hash",
      scopes: ["research:read"],
    }, "market:read")).rejects.toThrow("action_forbidden");
  });
});
