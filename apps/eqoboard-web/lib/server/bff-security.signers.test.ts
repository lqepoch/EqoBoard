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
}

function principal(permissions: readonly Permission[]): ServerPrincipal {
  return {
    identityIssuer: "https://id.example.test/native",
    subject: "subject-1",
    permissions,
    sessionExpiresAt: Date.now() + 120_000,
  };
}

async function verifyDelegation(
  token: string,
  secret: string,
  expected: Readonly<{ kid: string; issuer: string; audience: string; scope: string }>,
): Promise<void> {
  const header = decodeProtectedHeader(token);
  expect(header).toMatchObject({ alg: "HS256", typ: "JWT", kid: expected.kid });
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: expected.issuer,
    audience: expected.audience,
  });
  expect(payload.scope).toEqual([expected.scope]);
  expect(payload.sub).toBe("subject-1");
  expect(payload.exp! - payload.iat!).toBeGreaterThan(0);
  expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
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
