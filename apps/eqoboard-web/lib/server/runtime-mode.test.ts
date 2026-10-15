import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getNativeRuntimeMode,
  nativeResearchPublicOrigin,
  nativeRuntimeAllowsAuthorizedRoute,
  nativeRuntimeReadiness,
  requireRuntimeMode,
} from "./runtime-mode";

afterEach(() => vi.unstubAllEnvs());

function clearProfileEnvironment(): void {
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
    "NEXTAUTH_SECRET",
    "EQO_OIDC_CLIENT_SECRET",
    "EQO_OPENBB_OIDC_CLIENT_SECRET",
  ])
    vi.stubEnv(name, "");
}

function terminalProfile(): void {
  clearProfileEnvironment();
  vi.stubEnv("EQO_BFF_MODE", "terminal");
  vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "g".repeat(64));
  vi.stubEnv("MDP_TERMINAL_JWT_SECRET", "m".repeat(64));
}

function researchProfile(): void {
  clearProfileEnvironment();
  vi.stubEnv("EQO_BFF_MODE", "research");
  vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
}

function emptyOptionalServiceProfile(mode: "terminal" | "research"): void {
  clearProfileEnvironment();
  vi.stubEnv("EQO_BFF_MODE", mode);
}

describe("Native runtime profiles", () => {
  it("fails closed when runtime mode is missing or unknown", () => {
    vi.stubEnv("EQO_BFF_MODE", "");
    expect(getNativeRuntimeMode()).toBeNull();
    expect(nativeRuntimeReadiness()).toEqual({ mode: null, ready: false, profileIsolated: false });
    expect(requireRuntimeMode("terminal")?.status).toBe(503);

    vi.stubEnv("EQO_BFF_MODE", "Research");
    expect(getNativeRuntimeMode()).toBeNull();
    expect(requireRuntimeMode("research")?.status).toBe(503);
  });

  it("rejects cross-profile keys and does not fall back to the other signer", () => {
    terminalProfile();
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "x".repeat(64));
    expect(nativeRuntimeReadiness().ready).toBe(false);
    expect(requireRuntimeMode("terminal")?.status).toBe(503);

    vi.unstubAllEnvs();
    researchProfile();
    vi.stubEnv("ENGINE_TERMINAL_JWT_SECRET", "e".repeat(64));
    expect(nativeRuntimeReadiness().ready).toBe(false);
  });

  it("keeps runtime isolation ready when optional service signers are absent but rejects weak configured keys", () => {
    emptyOptionalServiceProfile("terminal");
    expect(nativeRuntimeReadiness()).toEqual({
      mode: "terminal",
      ready: true,
      profileIsolated: true,
    });

    vi.stubEnv("EQO_GATEWAY_JWT_SECRET", "too-short");
    expect(nativeRuntimeReadiness()).toEqual({
      mode: "terminal",
      ready: false,
      profileIsolated: false,
    });

    emptyOptionalServiceProfile("research");
    expect(nativeRuntimeReadiness()).toEqual({
      mode: "research",
      ready: true,
      profileIsolated: true,
    });
  });

  it("keeps the research runtime allowlist limited to Yahoo, private predictions, and diagnostic archive reads", () => {
    researchProfile();
    expect(nativeRuntimeReadiness().ready).toBe(true);
    expect(requireRuntimeMode("research")).toBeNull();
    expect(requireRuntimeMode("terminal")?.status).toBe(404);

    expect(
      nativeRuntimeAllowsAuthorizedRoute("research", "GET", "/api/research/yfinance/daily"),
    ).toBe(true);
    expect(
      nativeRuntimeAllowsAuthorizedRoute(
        "research",
        "GET",
        "/api/eqo/research/predictions/run-123",
      ),
    ).toBe(true);
    expect(
      nativeRuntimeAllowsAuthorizedRoute(
        "research",
        "GET",
        "/api/eqo/research/predictions/run:123+abc",
      ),
    ).toBe(true);
    expect(
      nativeRuntimeAllowsAuthorizedRoute(
        "research",
        "GET",
        "/api/eqo/research/predictions/run%3A123%2Babc",
      ),
    ).toBe(true);
    expect(
      nativeRuntimeAllowsAuthorizedRoute(
        "research",
        "GET",
        "/api/eqo/research/predictions/run%2Fother",
      ),
    ).toBe(false);
    expect(
      nativeRuntimeAllowsAuthorizedRoute(
        "research",
        "GET",
        "/api/eqo/market-data/datasets/ds-123/bars",
      ),
    ).toBe(true);
    expect(nativeRuntimeAllowsAuthorizedRoute("research", "GET", "/api/quotes")).toBe(false);
    expect(nativeRuntimeAllowsAuthorizedRoute("research", "GET", "/api/research/data/news")).toBe(
      false,
    );
    expect(nativeRuntimeAllowsAuthorizedRoute("research", "POST", "/api/research/ai")).toBe(false);
    expect(
      nativeRuntimeAllowsAuthorizedRoute(
        "research",
        "DELETE",
        "/api/eqo/research/predictions/run-123",
      ),
    ).toBe(false);
  });

  it("serves Yahoo only from research mode and does not mistake a second port for a separate host", () => {
    terminalProfile();
    vi.stubEnv("EQO_PUBLIC_ORIGIN", "https://terminal.example.test");
    vi.stubEnv("EQO_RESEARCH_PUBLIC_ORIGIN", "https://research.example.test");
    expect(nativeResearchPublicOrigin()).toBe("https://research.example.test");
    expect(
      nativeRuntimeAllowsAuthorizedRoute("terminal", "GET", "/api/research/yfinance/daily"),
    ).toBe(false);
    expect(nativeRuntimeAllowsAuthorizedRoute("terminal", "HEAD", "/api/quotes")).toBe(false);

    vi.stubEnv("EQO_RESEARCH_PUBLIC_ORIGIN", "https://terminal.example.test:8443");
    expect(nativeResearchPublicOrigin()).toBeNull();

    vi.stubEnv("EQO_BFF_MODE", "research");
    vi.stubEnv("MDP_RESEARCH_JWT_SECRET", "r".repeat(64));
    expect(nativeResearchPublicOrigin()).toBeNull();
  });
});
