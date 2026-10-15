import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const authMocks = vi.hoisted(() => ({ getToken: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-auth/jwt", () => authMocks);

const { getAuthUiSnapshot, ownerKeyForPrincipal } = await import("./auth");
const { authorizeRequest } = await import("./bff-security");

afterEach(() => {
  vi.unstubAllEnvs();
  authMocks.getToken.mockReset();
});

function setOidcEnvironment(mode: "terminal" | "research"): void {
  vi.stubEnv("EQO_BFF_MODE", mode);
  vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
  vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
  vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret-is-not-a-signer");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
  vi.stubEnv(
    "EQO_PUBLIC_ORIGIN",
    mode === "terminal" ? "https://terminal.example.test" : "https://research.example.test",
  );
  if (mode === "terminal") {
    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "g".repeat(64));
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "m".repeat(64));
    vi.stubEnv("EQO_RESEARCH_PUBLIC_ORIGIN", "https://research.example.test");
  } else {
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
  }
}

describe("server auth UI snapshot", () => {
  it("binds cache partitions to runtime mode and filters research UI permissions", async () => {
    const expiration = Math.floor(Date.now() / 1000) + 3_600;
    authMocks.getToken.mockResolvedValue({
      nativeIssuer: "https://id.example.test/native",
      nativeSubject: "subject-1",
      nativeRoles: [
        "eqoboard-market-reader",
        "eqoboard-private-research-reader",
        "eqoboard-research-ai-reader",
      ],
      nativeDisplayName: "Reader",
      nativeExpiresAt: expiration * 1_000,
      exp: expiration,
    });

    setOidcEnvironment("terminal");
    const terminal = await getAuthUiSnapshot();
    expect(authMocks.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ req: expect.any(NextRequest) }),
    );
    expect(terminal).toMatchObject({
      authenticated: true,
      runtimeMode: "terminal",
      researchOrigin: "https://research.example.test",
      permissions: [
        "market:read",
        "market:stream",
        "market:subscribe",
        "research:ai",
        "research:private-read",
        "research:read",
        "workspace:read",
      ],
    });

    vi.stubEnv("EQO_BFF_MODE", "research");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://research.example.test");
    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "");
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "");
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
    const research = await getAuthUiSnapshot();
    expect(research.authenticated).toBe(true);
    expect(research.runtimeMode).toBe("research");
    expect(research.researchOrigin).toBeNull();
    expect(research.permissions).toEqual(["market:read", "research:private-read", "research:read"]);
    expect(research.permissions).not.toContain("research:ai");
    expect(research.storagePartition).not.toBe(terminal.storagePartition);
  });

  it("grants AI only to the explicit terminal role and filters it from Research", async () => {
    const expiration = Math.floor(Date.now() / 1000) + 3_600;
    const claims = {
      nativeIssuer: "https://id.example.test/native",
      nativeSubject: "ai-reader-1",
      nativeRoles: ["eqoboard-research-ai-reader"],
      nativeExpiresAt: expiration * 1_000,
      exp: expiration,
    };
    authMocks.getToken.mockResolvedValue(claims);
    setOidcEnvironment("terminal");

    const aiReader = await getAuthUiSnapshot();
    expect(aiReader.authenticated).toBe(true);
    expect(aiReader.permissions).toEqual(["research:ai"]);

    authMocks.getToken.mockResolvedValue({ ...claims, nativeRoles: ["eqoboard-market-reader"] });
    const marketReader = await getAuthUiSnapshot();
    expect(marketReader.authenticated).toBe(true);
    expect(marketReader.permissions).toContain("market:read");
    expect(marketReader.permissions).not.toContain("research:ai");

    authMocks.getToken.mockResolvedValue({
      ...claims,
      nativeRoles: ["eqoboard-market-reader", "eqoboard-research-ai-reader"],
    });
    vi.stubEnv("EQO_BFF_MODE", "research");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://research.example.test");
    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "");
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "");
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
    const researchSnapshot = await getAuthUiSnapshot();
    expect(researchSnapshot.authenticated).toBe(true);
    expect(researchSnapshot.permissions).toEqual(["market:read", "research:read"]);
    expect(researchSnapshot.permissions).not.toContain("research:ai");

    authMocks.getToken.mockClear();
    const researchAiRoute = await authorizeRequest(
      new Request("https://research.example.test/api/research/ai", {
        method: "POST",
        headers: {
          Origin: "https://research.example.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      "research:ai",
    );
    expect(researchAiRoute.ok).toBe(false);
    if (!researchAiRoute.ok) expect(researchAiRoute.response.status).toBe(404);
    expect(authMocks.getToken).not.toHaveBeenCalled();
  });

  it("keeps valid OIDC sessions available when optional market signers are missing", async () => {
    const expiration = Math.floor(Date.now() / 1000) + 3_600;
    authMocks.getToken.mockResolvedValue({
      nativeIssuer: "https://id.example.test/native",
      nativeSubject: "subject-optional-services",
      nativeRoles: ["eqoboard-market-reader", "eqoboard-private-research-reader"],
      nativeExpiresAt: expiration * 1_000,
      exp: expiration,
    });

    setOidcEnvironment("terminal");
    for (const name of [
      "EQO_GATEWAY_JWT_SECRET",
      "MDP_TERMINAL_JWT_SECRET",
      "QUANT_TERMINAL_JWT_SECRET",
      "ENGINE_TERMINAL_JWT_SECRET",
      "EQO_RESEARCH_JWT_SECRET",
      "MDP_RESEARCH_JWT_SECRET",
      "QUANT_RESEARCH_JWT_SECRET",
      "ENGINE_RESEARCH_JWT_SECRET",
    ])
      vi.stubEnv(name, "");
    const terminal = await getAuthUiSnapshot();
    expect(terminal.authenticated).toBe(true);
    expect(terminal.runtimeMode).toBe("terminal");
    expect(terminal.storagePartition).toMatch(/^native-terminal-v1-[0-9a-f]{64}$/u);

    setOidcEnvironment("research");
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "");
    const research = await getAuthUiSnapshot();
    expect(research.authenticated).toBe(true);
    expect(research.runtimeMode).toBe("research");
    expect(research.permissions).toEqual(["market:read", "research:private-read", "research:read"]);
    expect(research.storagePartition).toMatch(/^native-research-v1-[0-9a-f]{64}$/u);
  });

  it("uses a secret-derived UI partition while preserving the database owner key", async () => {
    const expiration = Math.floor(Date.now() / 1000) + 3_600;
    const issuer = "https://id.example.test/native";
    const subject = "alice@example.test";
    authMocks.getToken.mockResolvedValue({
      nativeIssuer: issuer,
      nativeSubject: subject,
      nativeRoles: ["eqoboard-market-reader"],
      nativeExpiresAt: expiration * 1_000,
      exp: expiration,
    });
    setOidcEnvironment("terminal");

    const first = await getAuthUiSnapshot();
    const guessedSha256 = createHash("sha256")
      .update(issuer)
      .update("\0")
      .update(subject)
      .digest("hex");
    expect(first.storagePartition).toMatch(/^native-terminal-v1-[0-9a-f]{64}$/u);
    expect(first.storagePartition).not.toBe(`native-terminal-v1-${guessedSha256}`);
    expect(JSON.stringify(first)).not.toContain(issuer);
    expect(JSON.stringify(first)).not.toContain(subject);
    expect(
      ownerKeyForPrincipal({
        identityIssuer: issuer,
        subject,
      }),
    ).toBe(guessedSha256);
    expect(JSON.stringify(first)).not.toContain("n".repeat(64));

    authMocks.getToken.mockResolvedValue({
      nativeIssuer: issuer,
      nativeSubject: "bob@example.test",
      nativeRoles: ["eqoboard-market-reader"],
      nativeExpiresAt: expiration * 1_000,
      exp: expiration,
    });
    const otherIdentity = await getAuthUiSnapshot();
    expect(otherIdentity.storagePartition).not.toBe(first.storagePartition);

    authMocks.getToken.mockResolvedValue({
      nativeIssuer: issuer,
      nativeSubject: subject,
      nativeRoles: ["eqoboard-market-reader"],
      nativeExpiresAt: expiration * 1_000,
      exp: expiration,
    });
    vi.stubEnv("NEXTAUTH_SECRET", "z".repeat(64));
    const afterSecretRotation = await getAuthUiSnapshot();
    expect(afterSecretRotation.storagePartition).not.toBe(first.storagePartition);
  });
});
