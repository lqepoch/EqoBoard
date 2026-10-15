import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ getToken: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-auth/jwt", () => authMocks);

const { getAuthUiSnapshot } = await import("./auth");

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
      nativeRoles: ["eqoboard-market-reader", "eqoboard-private-research-reader"],
      nativeDisplayName: "Reader",
      nativeExpiresAt: expiration * 1_000,
      exp: expiration,
    });

    setOidcEnvironment("terminal");
    const terminal = await getAuthUiSnapshot();
    expect(terminal).toMatchObject({
      authenticated: true,
      runtimeMode: "terminal",
      researchOrigin: "https://research.example.test",
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
    expect(research.storagePartition).toBe(
      `native-research-v1-${terminal.storagePartition?.slice("native-terminal-v1-".length)}`,
    );
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
});
