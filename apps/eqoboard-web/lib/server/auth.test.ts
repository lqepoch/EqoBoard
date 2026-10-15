import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { ownerKeyForPrincipal, principalFromClaims } = await import("./auth");
const { authCookieName, authOptions } =
  await vi.importActual<typeof import("../../auth")>("../../auth");

afterEach(() => vi.unstubAllEnvs());

describe("server principal projection", () => {
  it("accepts only the current issuer and caps the principal at every expiry boundary", () => {
    vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example/tenant/native");
    const principal = principalFromClaims(
      {
        nativeIssuer: "https://id.example/tenant/native",
        nativeSubject: "subject-1",
        nativeRoles: ["eqoboard-market-reader", "unknown-role"],
        nativeExpiresAt: 90_000,
        nativeProviderExpiresAt: 60_000,
        exp: 100,
      },
      1_000,
    );
    expect(principal).toEqual({
      identityIssuer: "https://id.example/tenant/native",
      subject: "subject-1",
      permissions: [
        "market:read",
        "market:stream",
        "market:subscribe",
        "research:read",
        "workspace:read",
      ],
      sessionExpiresAt: 60_000,
    });
    expect(
      principalFromClaims(
        {
          nativeIssuer: "https://other.example",
          nativeSubject: "subject-1",
          nativeRoles: ["eqoboard-market-reader"],
          nativeExpiresAt: 90_000,
          exp: 100,
        },
        1_000,
      ),
    ).toBeNull();
  });

  it("rejects expired, malformed, and control-character identities while preserving issuer namespace", () => {
    vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example");
    const base = {
      nativeIssuer: "https://id.example",
      nativeSubject: "subject-1",
      nativeRoles: ["eqoboard-market-reader"],
      nativeExpiresAt: 10_000,
      exp: 10,
    };
    expect(principalFromClaims(base, 9_000)).toBeNull();
    expect(principalFromClaims({ ...base, nativeSubject: "bad\nsubject" }, 1_000)).toBeNull();
    const principal = principalFromClaims({ ...base, nativeExpiresAt: 20_000, exp: 20 }, 1_000);
    expect(principal).not.toBeNull();
    if (!principal) throw new Error("Expected a validated principal.");
    expect(ownerKeyForPrincipal(principal)).not.toBe(
      ownerKeyForPrincipal({
        identityIssuer: "https://other.example",
        subject: "subject-1",
      }),
    );
    expect(principalFromClaims({ ...base, nativeProviderExpiresAt: "later" }, 1_000)).toBeNull();
  });

  it("uses distinct secure cookie names for terminal and research host sessions", () => {
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://terminal.example.test");
    vi.stubEnv("EQO_BFF_MODE", "terminal");
    expect(authCookieName()).toBe("__Host-eqoboard.session-token");

    vi.stubEnv("EQO_BFF_MODE", "research");
    expect(authCookieName()).toBe("__Host-eqoboard-research.session-token");
  });

  it("requires PKCE, state, and nonce with realm-isolated nonce cookies", async () => {
    const oidcProvider = authOptions.providers.find(
      (provider) => typeof provider === "object" && "id" in provider && provider.id === "eqo-oidc",
    );
    expect(oidcProvider).toMatchObject({ checks: ["pkce", "state", "nonce"] });

    vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
    vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
    vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret");
    vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
    vi.stubEnv("EQO_BFF_MODE", "terminal");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://terminal.example.test");
    vi.stubEnv("NEXTAUTH_URL", "https://terminal.example.test");
    vi.resetModules();
    const { authOptions: terminalOptions } = await import("../../auth");
    expect(terminalOptions.cookies?.nonce).toMatchObject({
      name: "__Host-eqoboard.nonce",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    });

    vi.stubEnv("EQO_BFF_MODE", "research");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://research.example.test");
    vi.stubEnv("NEXTAUTH_URL", "https://research.example.test");
    vi.resetModules();
    const { authOptions: researchOptions } = await import("../../auth");
    expect(researchOptions.cookies?.nonce).toMatchObject({
      name: "__Host-eqoboard-research.nonce",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    });
  });
});
