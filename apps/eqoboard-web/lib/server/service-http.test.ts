import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mdpBaseUrl } from "./service-http";

afterEach(() => vi.unstubAllEnvs());

function setLocalEnvironment(): void {
  vi.stubEnv("EQO_LOCAL_ACCESS", "true");
  vi.stubEnv("EQO_LOCAL_BIND", "127.0.0.1");
  vi.stubEnv("EQO_BFF_MODE", "terminal");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("EQO_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "n".repeat(64));
}

describe("MDP service origin", () => {
  it("requires the explicit local Core Bars opt-in and exact loopback origin", () => {
    setLocalEnvironment();
    vi.stubEnv("EQO_MDP_URL", "http://127.0.0.1:8088");
    expect(mdpBaseUrl()).toBeNull();

    vi.stubEnv("EQO_LOCAL_CORE_BARS", "true");
    expect(mdpBaseUrl()?.toString()).toBe("http://127.0.0.1:8088/");

    for (const value of [
      "http://127.0.0.1:8089",
      "http://localhost:8088",
      "http://[::1]:8088",
      "http://127.0.0.1:8088/",
      "https://market-data-platform.example",
      "http://market-data-platform:8088",
    ]) {
      vi.stubEnv("EQO_MDP_URL", value);
      expect(mdpBaseUrl(), value).toBeNull();
    }
  });

  it("does not opt in with a malformed workstation boundary or approximate flag", () => {
    setLocalEnvironment();
    vi.stubEnv("EQO_LOCAL_CORE_BARS", "TRUE");
    vi.stubEnv("EQO_MDP_URL", "http://127.0.0.1:8088");
    expect(mdpBaseUrl()).toBeNull();

    vi.stubEnv("EQO_LOCAL_CORE_BARS", "true");
    vi.stubEnv("EQO_LOCAL_BIND", "0.0.0.0");
    expect(mdpBaseUrl()).toBeNull();
  });

  it("preserves the configured HTTPS MDP origin in OIDC mode", () => {
    vi.stubEnv("EQO_LOCAL_ACCESS", "");
    vi.stubEnv("EQO_LOCAL_CORE_BARS", "true");
    vi.stubEnv("EQO_MDP_URL", "https://mdp.example.test");
    expect(mdpBaseUrl()?.origin).toBe("https://mdp.example.test");
  });
});
