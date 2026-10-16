import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeProtectedHeader, jwtVerify } from "jose";
import type { Permission } from "../contracts/auth";
import type { ServerPrincipal } from "./auth";

vi.mock("server-only", () => ({}));

const security = await import("./bff-security");

afterEach(() => vi.unstubAllEnvs());

function commonIdentity(): void {
  vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
  vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
  vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret-not-a-signer");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
  vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://native.example.test");
  vi.stubEnv("NEXTAUTH_URL", "https://native.example.test");
}

function principal(permissions: readonly Permission[]): ServerPrincipal {
  return {
    identityIssuer: "https://id.example.test/native",
    subject: "subject-1",
    permissions,
    sessionExpiresAt: Date.now() + 120_000,
  };
}

function localWorkstationPrincipal(
  permissions: readonly Permission[] = ["market:read"],
  sessionExpiresAt = Date.now() + 120_000,
): ServerPrincipal {
  return {
    identityIssuer: "http://127.0.0.1:3000/local-workstation",
    subject: "local-workstation",
    permissions,
    sessionExpiresAt,
  };
}

function localWorkstationEnvironment(enableCoreBars = true): void {
  for (const name of [
    "EQO_OIDC_ISSUER",
    "EQO_OIDC_CLIENT_ID",
    "EQO_OIDC_CLIENT_SECRET",
    "EQO_OPENBB_OIDC_CLIENT_SECRET",
    "EQO_GATEWAY_JWT_SECRET",
    "MDP_TERMINAL_JWT_SECRET",
    "MDP_RESEARCH_JWT_SECRET",
    "QUANT_TERMINAL_JWT_SECRET",
    "QUANT_RESEARCH_JWT_SECRET",
    "ENGINE_TERMINAL_JWT_SECRET",
    "ENGINE_RESEARCH_JWT_SECRET",
    "EQO_RESEARCH_JWT_SECRET",
    "EQO_RESEARCH_API_KEY",
    "ALPACA_KEY",
    "ALPACA_SECRET",
    "EQO_ADAPTER_ALPACA_TOKEN",
    "EQO_ADAPTER_IBKR_TOKEN",
    "EQO_ADAPTER_SCHWAB_TOKEN",
    "ANTHROPIC_API_KEY",
  ]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("EQO_LOCAL_ACCESS", "true");
  vi.stubEnv("EQO_LOCAL_CORE_BARS", enableCoreBars ? "true" : "false");
  vi.stubEnv("EQO_LOCAL_BIND", "127.0.0.1");
  vi.stubEnv("EQO_BFF_MODE", "terminal");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
  vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "g".repeat(64));
  vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "m".repeat(64));
}

async function verifyDelegation(
  token: string,
  secret: string,
  expected: Readonly<{
    kid: string;
    issuer: string;
    audience: string;
    scope: string;
    subject?: string;
  }>,
): Promise<void> {
  const header = decodeProtectedHeader(token);
  expect(header).toMatchObject({ alg: "HS256", typ: "JWT", kid: expected.kid });
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: expected.issuer,
    audience: expected.audience,
  });
  expect(payload.scope).toEqual([expected.scope]);
  expect(payload.sub).toBe(expected.subject ?? "subject-1");
  const expiration = payload.exp;
  const issuedAt = payload.iat;
  if (typeof expiration !== "number" || typeof issuedAt !== "number") {
    throw new Error("Delegation token must include numeric iat and exp claims.");
  }
  const lifetimeSeconds = expiration - issuedAt;
  expect(lifetimeSeconds).toBeGreaterThan(0);
  expect(lifetimeSeconds).toBeLessThanOrEqual(60);
}

describe("mode-isolated service signers", () => {
  it("uses only the existing research MDP identity and rejects Yahoo delegation in terminal mode", async () => {
    commonIdentity();
    const mdpResearchSecret = "r".repeat(64);
    vi.stubEnv("EQO_BFF_MODE", "research");
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", mdpResearchSecret);

    const result = await security.signMdpResearchReadDelegation(principal(["research:read"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      await verifyDelegation(result.token, mdpResearchSecret, {
        kid: "mdp-research",
        issuer: "openterminal-research",
        audience: "lqepoch-market-data",
        scope: "market:read",
      });
    }

    vi.stubEnv("EQO_BFF_MODE", "terminal");
    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "g".repeat(64));
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "m".repeat(64));
    const denied = await security.signMdpResearchReadDelegation(principal(["research:read"]));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(404);
  });

  it("signs local Core Bars only with the fixed MDP terminal read identity and distinct key", async () => {
    localWorkstationEnvironment();
    const local = localWorkstationPrincipal();
    const mdp = await security.signMdpMarketReadDelegation(local);
    expect(mdp.ok).toBe(true);
    if (!mdp.ok) return;
    await verifyDelegation(mdp.token, "m".repeat(64), {
      kid: "mdp-terminal",
      issuer: "eqoboard-openterminal",
      audience: "lqepoch-market-data",
      scope: "market:read",
      subject: "local-workstation",
    });
    const { payload: mdpPayload } = await jwtVerify(
      mdp.token,
      new TextEncoder().encode("m".repeat(64)),
      { issuer: "eqoboard-openterminal", audience: "lqepoch-market-data" },
    );
    expect(mdpPayload.idp_iss).toBe("http://127.0.0.1:3000/local-workstation");
    expect(mdpPayload.sub).toBe("local-workstation");

    const gateway = await security.signGatewayDelegation(local, "market:read");
    expect(gateway.ok).toBe(true);
    if (gateway.ok) {
      await verifyDelegation(gateway.token, "g".repeat(64), {
        kid: "bff",
        issuer: "eqoboard-openterminal",
        audience: "eqoboard-gateway",
        scope: "market:read",
        subject: "local-workstation",
      });
      expect(gateway.token).not.toBe(mdp.token);
    }
  });

  it("fails closed for local MDP signing without the flag, key, valid identity, or market scope", async () => {
    localWorkstationEnvironment(false);
    const local = localWorkstationPrincipal();
    const disabled = await security.signMdpMarketReadDelegation(local);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.response.status).toBe(403);

    localWorkstationEnvironment();
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "");
    const missingKey = await security.signMdpMarketReadDelegation(local);
    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) expect(missingKey.response.status).toBe(503);

    localWorkstationEnvironment();
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "g".repeat(64));
    const reusedKey = await security.signMdpMarketReadDelegation(local);
    expect(reusedKey.ok).toBe(false);
    if (!reusedKey.ok) expect(reusedKey.response.status).toBe(503);

    localWorkstationEnvironment();
    const forged = [
      { ...local, identityIssuer: "https://id.example.test/local-workstation" },
      { ...local, subject: "another-workstation" },
      { ...local, sessionExpiresAt: Date.now() + 500 },
      { ...local, permissions: ["market:stream"] as const },
    ];
    for (const principal of forged) {
      const denied = await security.signMdpMarketReadDelegation(principal);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.response.status).toBe(403);
    }

    const research = await security.signMdpResearchReadDelegation({
      ...local,
      permissions: ["market:read", "research:read"],
    });
    expect(research.ok).toBe(false);
    if (!research.ok) expect(research.response.status).toBe(404);

    const quant = await security.signQuantPredictionReadDelegation({
      ...local,
      permissions: ["market:read", "research:private-read"],
    });
    expect(quant.ok).toBe(false);
    if (!quant.ok) expect(quant.response.status).toBe(403);

    const engine = await security.signEngineOfflineReadDelegation({
      ...local,
      permissions: ["market:read", "engine:offline-read"],
    });
    expect(engine.ok).toBe(false);
    if (!engine.ok) expect(engine.response.status).toBe(403);
  });

  it("preserves OIDC MDP terminal signing when local Core Bars is not enabled", async () => {
    commonIdentity();
    vi.stubEnv("EQO_BFF_MODE", "terminal");
    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "g".repeat(64));
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "m".repeat(64));
    vi.stubEnv("EQO_LOCAL_CORE_BARS", "false");

    const result = await security.signMdpMarketReadDelegation(principal(["market:read"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { payload } = await jwtVerify(result.token, new TextEncoder().encode("m".repeat(64)), {
        issuer: "eqoboard-openterminal",
        audience: "lqepoch-market-data",
      });
      expect(payload.sub).toBe("subject-1");
      expect(payload.idp_iss).toBe("https://id.example.test/native");
      expect(payload.scope).toEqual(["market:read"]);
    }
  });

  it("selects private Quant issuer and key from the active isolated runtime", async () => {
    commonIdentity();
    const quantResearchSecret = "q".repeat(64);
    vi.stubEnv("EQO_BFF_MODE", "research");
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
    vi.stubEnv("QUANT_RESEARCH_JWT_SECRET", quantResearchSecret);

    const research = await security.signQuantPredictionReadDelegation(
      principal(["research:private-read"]),
    );
    expect(research.ok).toBe(true);
    if (research.ok) {
      await verifyDelegation(research.token, quantResearchSecret, {
        kid: "quant-research",
        issuer: "openterminal-research",
        audience: "lqepoch-quant-research",
        scope: "research:private-read",
      });
    }

    vi.stubEnv("EQO_BFF_MODE", "terminal");
    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "g".repeat(64));
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "m".repeat(64));
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "");
    vi.stubEnv("QUANT_RESEARCH_JWT_SECRET", "");
    const quantTerminalSecret = "t".repeat(64);
    vi.stubEnv("QUANT_TERMINAL_JWT_SECRET", quantTerminalSecret);
    const terminal = await security.signQuantPredictionReadDelegation(
      principal(["research:private-read"]),
    );
    expect(terminal.ok).toBe(true);
    if (terminal.ok) {
      await verifyDelegation(terminal.token, quantTerminalSecret, {
        kid: "quant-terminal",
        issuer: "eqoboard-openterminal",
        audience: "lqepoch-quant-research",
        scope: "research:private-read",
      });
    }
  });
});
