import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { ownerKeyForPrincipal, principalFromClaims } = await import("./auth");
const {
  authCookieName,
  authOptions,
  isLocalWorkstationRequestAllowed,
  isOidcConfigured,
  localWorkstationModeEnabled,
  localWorkstationModeRequested,
} = await vi.importActual<typeof import("../../auth")>("../../auth");

afterEach(() => vi.unstubAllEnvs());

function setLocalWorkstationEnvironment(): void {
  vi.stubEnv("EQO_LOCAL_ACCESS", "true");
  vi.stubEnv("EQO_BFF_MODE", "terminal");
  vi.stubEnv("EQO_LOCAL_BIND", "127.0.0.1");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
}

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

  it("requires an explicit matching NextAuth URL while keeping configured loopback origins usable", () => {
    vi.stubEnv("EQO_LOCAL_ACCESS", "");
    vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
    vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
    vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret");
    vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
    vi.stubEnv("EQO_SESSION_TTL_SECONDS", "3600");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://terminal.example.test");
    vi.stubEnv("NEXTAUTH_URL", "");

    expect(isOidcConfigured()).toBe(false);
    vi.stubEnv("NEXTAUTH_URL", "https://other.example.test");
    expect(isOidcConfigured()).toBe(false);
    vi.stubEnv("NEXTAUTH_URL", "https://terminal.example.test/other-auth-path");
    expect(isOidcConfigured()).toBe(false);
    vi.stubEnv("NEXTAUTH_URL", "https://user:password@terminal.example.test");
    expect(isOidcConfigured()).toBe(false);
    vi.stubEnv("NEXTAUTH_URL", "https://terminal.example.test");
    expect(isOidcConfigured()).toBe(true);

    vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://localhost:3000");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    expect(isOidcConfigured()).toBe(true);
    vi.stubEnv("NEXTAUTH_URL", "");
    expect(isOidcConfigured()).toBe(false);
  });

  it("keeps OIDC unchanged by default and disables it only when local mode is explicitly selected", () => {
    vi.stubEnv("EQO_LOCAL_ACCESS", "");
    vi.stubEnv("EQO_OIDC_ISSUER", "https://id.example.test/native");
    vi.stubEnv("EQO_OIDC_CLIENT_ID", "native-client");
    vi.stubEnv("EQO_OIDC_CLIENT_SECRET", "oidc-client-secret");
    vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
    vi.stubEnv("EQO_SESSION_TTL_SECONDS", "3600");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://terminal.example.test");
    vi.stubEnv("NEXTAUTH_URL", "https://terminal.example.test");
    expect(isOidcConfigured()).toBe(true);
    expect(localWorkstationModeRequested()).toBe(false);

    setLocalWorkstationEnvironment();
    expect(localWorkstationModeRequested()).toBe(true);
    expect(localWorkstationModeEnabled()).toBe(true);
    expect(isOidcConfigured()).toBe(false);
  });

  it("requires the exact local bind, canonical origin, and matching NextAuth URL", () => {
    setLocalWorkstationEnvironment();
    expect(localWorkstationModeEnabled()).toBe(true);
    vi.stubEnv("PORT", "");
    expect(localWorkstationModeEnabled()).toBe(true);
    vi.stubEnv("PORT", "3000");

    vi.stubEnv("EQO_LOCAL_BIND", "0.0.0.0");
    expect(localWorkstationModeEnabled()).toBe(false);
    vi.stubEnv("EQO_LOCAL_BIND", "127.0.0.1");
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    expect(localWorkstationModeEnabled()).toBe(false);
    vi.stubEnv("HOSTNAME", "127.0.0.1");
    vi.stubEnv("PORT", "3001");
    expect(localWorkstationModeEnabled()).toBe(false);
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3001");
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3001");
    expect(localWorkstationModeEnabled()).toBe(true);
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://localhost:3000");
    expect(localWorkstationModeEnabled()).toBe(false);
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000/auth");
    expect(localWorkstationModeEnabled()).toBe(false);
  });

  it("accepts Next.js default forwarding metadata only when it agrees with the actual loopback host", () => {
    setLocalWorkstationEnvironment();
    const headers = new Headers({
      host: "127.0.0.1:3000",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3000",
      "x-forwarded-for": "127.0.0.1",
    });
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/quotes", { headers }),
      ),
    ).toBe(true);

    vi.stubEnv("PORT", "3001");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3001");
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3001");
    headers.set("host", "127.0.0.1:3001");
    headers.set("x-forwarded-host", "127.0.0.1:3001");
    headers.set("x-forwarded-port", "3001");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3001/api/quotes", { headers }),
      ),
    ).toBe(true);
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
    headers.set("host", "127.0.0.1:3000");
    headers.set("x-forwarded-host", "127.0.0.1:3000");
    headers.set("x-forwarded-port", "3000");

    headers.set("x-forwarded-host", "attacker.example");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/quotes", { headers }),
      ),
    ).toBe(false);
    headers.set("x-forwarded-host", "127.0.0.1:3000");
    headers.set("x-forwarded-proto", "https");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/quotes", { headers }),
      ),
    ).toBe(false);
    headers.set("x-forwarded-proto", "http");
    headers.set("x-forwarded-port", "443");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/quotes", { headers }),
      ),
    ).toBe(false);

    headers.set("x-forwarded-port", "3000");
    headers.set("Forwarded", "host=attacker.example;proto=https");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/quotes", { headers }),
      ),
    ).toBe(false);

    headers.delete("Forwarded");
    headers.set("X-Original-Host", "attacker.example");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/quotes", { headers }),
      ),
    ).toBe(false);
    headers.delete("X-Original-Host");
    headers.set("x-forwarded-user", "attacker");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/quotes", { headers }),
      ),
    ).toBe(false);
  });

  it("rejects remote hosts and keeps same-origin CSRF checks for local writes", () => {
    setLocalWorkstationEnvironment();
    const commonHeaders = {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3000",
    };
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://attacker.example/api/quotes", {
          headers: { ...commonHeaders, host: "attacker.example" },
        }),
      ),
    ).toBe(false);
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://attacker.example/api/quotes", { headers: commonHeaders }),
      ),
    ).toBe(false);

    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/", {
          headers: { ...commonHeaders, "Sec-Fetch-Site": "none" },
        }),
      ),
    ).toBe(true);

    const safeWriteHeaders = {
      ...commonHeaders,
      Origin: "http://127.0.0.1:3000",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "same-origin",
    };
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/workspaces", {
          method: "POST",
          headers: safeWriteHeaders,
        }),
      ),
    ).toBe(true);
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/workspaces", {
          method: "POST",
          headers: { ...safeWriteHeaders, "Sec-Fetch-Mode": "cors" },
        }),
      ),
    ).toBe(true);
    const corsWithoutSameOriginSite = new Headers({
      ...safeWriteHeaders,
      "Sec-Fetch-Mode": "cors",
    });
    corsWithoutSameOriginSite.delete("Sec-Fetch-Site");
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/workspaces", {
          method: "POST",
          headers: corsWithoutSameOriginSite,
        }),
      ),
    ).toBe(false);
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/workspaces", {
          method: "POST",
          headers: commonHeaders,
        }),
      ),
    ).toBe(false);
    expect(
      isLocalWorkstationRequestAllowed(
        new Request("http://127.0.0.1:3000/api/workspaces", {
          method: "POST",
          headers: { ...safeWriteHeaders, Origin: "http://attacker.example" },
        }),
      ),
    ).toBe(false);
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
