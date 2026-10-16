import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const authMocks = vi.hoisted(() => ({ getToken: vi.fn() }));
const requestMocks = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => requestMocks.headers }));
vi.mock("next-auth/jwt", () => authMocks);

const { getAuthUiSnapshot, ownerKeyForPrincipal } = await import("./auth");
const { authorizeRequest } = await import("./bff-security");
const { isLocalWorkstationRequestAllowed } =
  await vi.importActual<typeof import("../../auth")>("../../auth");

afterEach(() => {
  vi.unstubAllEnvs();
  authMocks.getToken.mockReset();
  requestMocks.headers = new Headers();
});

function setOidcEnvironment(mode: "terminal" | "research"): void {
  vi.stubEnv("EQO_LOCAL_ACCESS", "");
  vi.stubEnv("EQO_BFF_MODE", mode);
  vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
  vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
  vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret-is-not-a-signer");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
  const origin =
    mode === "terminal" ? "https://terminal.example.test" : "https://research.example.test";
  vi.stubEnv("EQO_PUBLIC_ORIGIN", origin);
  vi.stubEnv("NEXTAUTH_URL", origin);
  if (mode === "terminal") {
    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "g".repeat(64));
    vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "m".repeat(64));
    vi.stubEnv("EQO_RESEARCH_PUBLIC_ORIGIN", "https://research.example.test");
  } else {
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
  }
}

function setLocalWorkstationEnvironment(): void {
  for (const name of [
    "EQO_GATEWAY_JWT_SECRET",
    "MDP_TERMINAL_JWT_SECRET",
    "QUANT_TERMINAL_JWT_SECRET",
    "ENGINE_TERMINAL_JWT_SECRET",
    "EQO_RESEARCH_JWT_SECRET",
    "MDP_RESEARCH_JWT_SECRET",
    "QUANT_RESEARCH_JWT_SECRET",
    "ENGINE_RESEARCH_JWT_SECRET",
    "EQO_RESEARCH_API_KEY",
    "ALPACA_KEY",
    "ALPACA_SECRET",
    "EQO_ADAPTER_ALPACA_TOKEN",
    "EQO_ADAPTER_IBKR_TOKEN",
    "EQO_ADAPTER_SCHWAB_TOKEN",
    "ANTHROPIC_API_KEY",
    "EQO_OIDC_CLIENT_SECRET",
    "EQO_OPENBB_OIDC_CLIENT_SECRET",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("EQO_LOCAL_ACCESS", "true");
  vi.stubEnv("EQO_LOCAL_BIND", "127.0.0.1");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("EQO_BFF_MODE", "terminal");
  vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
  requestMocks.headers = new Headers({
    host: "127.0.0.1:3000",
    "x-forwarded-host": "127.0.0.1:3000",
    "x-forwarded-proto": "http",
    "x-forwarded-port": "3000",
    "x-forwarded-for": "127.0.0.1",
  });
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
    vi.stubEnv("NEXTAUTH_URL", "https://research.example.test");
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
    vi.stubEnv("NEXTAUTH_URL", "https://research.example.test");
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

  it("projects local workstation identity without OIDC claims and limits its permissions", async () => {
    setLocalWorkstationEnvironment();

    const serverComponentRequest = new NextRequest("http://127.0.0.1:3000/", {
      headers: requestMocks.headers,
    });
    expect(new URL(serverComponentRequest.url).origin).toBe("http://localhost:3000");
    expect(isLocalWorkstationRequestAllowed(serverComponentRequest)).toBe(true);

    const local = await getAuthUiSnapshot();
    expect(local).toMatchObject({
      status: "authenticated",
      authenticated: true,
      displayName: "Local workstation",
      identityType: "local-workstation",
      runtimeMode: "terminal",
      researchOrigin: null,
      permissions: [
        "market:read",
        "market:stream",
        "market:subscribe",
        "orders:preview",
        "research:read",
        "workspace:read",
        "workspace:write",
      ],
    });
    expect(local.storagePartition).toMatch(/^native-terminal-v1-[0-9a-f]{64}$/u);
    expect(local.permissions).not.toContain("paper:submit");
    expect(local.permissions).not.toContain("research:ai");
    expect(local.permissions).not.toContain("engine:offline-read");
    expect(authMocks.getToken).not.toHaveBeenCalled();

    const forgedHost = await authorizeRequest(
      new Request("http://127.0.0.1:3000/api/quotes", {
        headers: {
          host: "127.0.0.1:3000",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
          "x-forwarded-port": "3000",
        },
      }),
      "market:read",
    );
    expect(forgedHost.ok).toBe(false);
    if (!forgedHost.ok) expect(forgedHost.response.status).toBe(403);

    const csrfRejected = await authorizeRequest(
      new Request("http://127.0.0.1:3000/api/workspaces", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          "x-forwarded-host": "127.0.0.1:3000",
          "x-forwarded-proto": "http",
          "x-forwarded-port": "3000",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      "workspace:write",
    );
    expect(csrfRejected.ok).toBe(false);
    if (!csrfRejected.ok) expect(csrfRejected.response.status).toBe(403);

    const writeHeaders = {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3000",
      Origin: "http://127.0.0.1:3000",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Content-Type": "application/json",
    };
    const orderPreview = await authorizeRequest(
      new Request("http://127.0.0.1:3000/api/eqo/orders/preview", {
        method: "POST",
        headers: writeHeaders,
        body: "{}",
      }),
      "orders:preview",
    );
    expect(orderPreview.ok).toBe(true);

    const crossOriginWrite = await authorizeRequest(
      new Request("http://127.0.0.1:3000/api/eqo/orders/preview", {
        method: "POST",
        headers: { ...writeHeaders, Origin: "http://attacker.example" },
        body: "{}",
      }),
      "orders:preview",
    );
    expect(crossOriginWrite.ok).toBe(false);
    if (!crossOriginWrite.ok) expect(crossOriginWrite.response.status).toBe(403);

    for (const permission of ["paper:submit", "research:ai", "engine:offline-read"] as const) {
      const denied = await authorizeRequest(
        new Request("http://127.0.0.1:3000/api/quotes", {
          headers: {
            host: "127.0.0.1:3000",
            "x-forwarded-host": "127.0.0.1:3000",
            "x-forwarded-proto": "http",
            "x-forwarded-port": "3000",
          },
        }),
        permission,
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.response.status).toBe(403);
    }
  });

  it("does not project local identity for a remote Host or a forged forwarded host", async () => {
    setLocalWorkstationEnvironment();
    requestMocks.headers.set("host", "attacker.example");
    const remote = await getAuthUiSnapshot();
    expect(remote).toMatchObject({ status: "identity-unavailable", authenticated: false });

    requestMocks.headers.set("host", "127.0.0.1:3000");
    requestMocks.headers.set("x-forwarded-host", "attacker.example");
    const forwarded = await getAuthUiSnapshot();
    expect(forwarded).toMatchObject({ status: "identity-unavailable", authenticated: false });
    expect(authMocks.getToken).not.toHaveBeenCalled();
  });
});
