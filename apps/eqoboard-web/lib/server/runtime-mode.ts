import "server-only";

import { NextResponse } from "next/server";
import {
  localWorkstationModeEnabled,
  localWorkstationModeRequested,
  publicAppOrigin,
} from "@/auth";

export type NativeRuntimeMode = "terminal" | "research";

const TERMINAL_SIGNER_ENV = [
  "EQO_GATEWAY_JWT_SECRET",
  "MDP_TERMINAL_JWT_SECRET",
  "QUANT_TERMINAL_JWT_SECRET",
  "ENGINE_TERMINAL_JWT_SECRET",
] as const;

const RESEARCH_SIGNER_ENV = [
  "EQO_RESEARCH_JWT_SECRET",
  "MDP_RESEARCH_JWT_SECRET",
  "QUANT_RESEARCH_JWT_SECRET",
  "ENGINE_RESEARCH_JWT_SECRET",
] as const;

const MARKET_PROVIDER_CREDENTIAL_ENV = [
  "ALPACA_KEY",
  "ALPACA_SECRET",
  "EQO_ADAPTER_ALPACA_TOKEN",
  "EQO_ADAPTER_IBKR_TOKEN",
  "EQO_ADAPTER_SCHWAB_TOKEN",
] as const;

const RESEARCH_ONLY_ENV = [...RESEARCH_SIGNER_ENV, "EQO_RESEARCH_API_KEY"] as const;

const TERMINAL_ONLY_ENV = [
  ...TERMINAL_SIGNER_ENV,
  ...MARKET_PROVIDER_CREDENTIAL_ENV,
  "ANTHROPIC_API_KEY",
] as const;

const ALL_SIGNING_ENV = [
  "NEXTAUTH_SECRET",
  "EQO_OIDC_CLIENT_SECRET",
  "EQO_OPENBB_OIDC_CLIENT_SECRET",
  ...TERMINAL_SIGNER_ENV,
  ...RESEARCH_SIGNER_ENV,
] as const;

const ALL_SERVICE_SIGNER_ENV = [...TERMINAL_SIGNER_ENV, ...RESEARCH_SIGNER_ENV] as const;

export type NativeRuntimeReadiness = Readonly<{
  mode: NativeRuntimeMode | null;
  ready: boolean;
  profileIsolated: boolean;
}>;

/** Missing or misspelled mode is unknown; it never defaults to terminal. */
export function getNativeRuntimeMode(): NativeRuntimeMode | null {
  const mode = process.env.EQO_BFF_MODE;
  return mode === "terminal" || mode === "research" ? mode : null;
}

function isConfigured(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

function validSigningSecret(name: string): boolean {
  const value = process.env[name];
  return Boolean(value && value.length >= 64 && /^[\x21-\x7e]+$/u.test(value));
}

function distinctConfiguredSigningSecrets(): boolean {
  const values = ALL_SIGNING_ENV.map((name) => process.env[name]).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return new Set(values).size === values.length;
}

function configuredSigningSecretsAreValid(): boolean {
  return ALL_SERVICE_SIGNER_ENV.every((name) => !isConfigured(name) || validSigningSecret(name));
}

function profileIsolated(mode: NativeRuntimeMode | null): boolean {
  if (!mode) return false;
  if (localWorkstationModeRequested() && (mode !== "terminal" || !localWorkstationModeEnabled())) {
    return false;
  }
  const oppositeProfile = mode === "terminal" ? RESEARCH_ONLY_ENV : TERMINAL_ONLY_ENV;
  if (
    oppositeProfile.some(isConfigured) ||
    !configuredSigningSecretsAreValid() ||
    !distinctConfiguredSigningSecrets()
  ) {
    return false;
  }

  // Individual services are optional. Their fixed signer validates its own
  // key before dispatch and returns 503 when unavailable; missing one source
  // must not make OIDC, workspace persistence, or the rest of the app unusable.
  return true;
}

export function nativeRuntimeReadiness(): NativeRuntimeReadiness {
  const mode = getNativeRuntimeMode();
  const isolated = profileIsolated(mode);
  return Object.freeze({ mode, ready: mode !== null && isolated, profileIsolated: isolated });
}

/**
 * Research mode serves only its frozen, read-only NativeResearch allowlist.
 * The terminal has its separate complete route surface; Yahoo is excluded
 * there even when the signed-in principal also has research:read.
 */
export function nativeRuntimeAllowsAuthorizedRoute(
  mode: NativeRuntimeMode,
  method: string,
  pathname: string,
): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return false;
  if (mode === "terminal") return pathname !== "/api/research/yfinance/daily";
  if (normalizedMethod !== "GET") return false;
  const predictionPrefix = "/api/eqo/research/predictions/";
  const predictionSegment = pathname.startsWith(predictionPrefix)
    ? pathname.slice(predictionPrefix.length)
    : "";
  let decodedRunId = "";
  try {
    decodedRunId = decodeURIComponent(predictionSegment);
  } catch {
    // Malformed escapes are not a route in the Research profile.
  }
  return (
    pathname === "/api/research/yfinance/daily" ||
    (predictionSegment.length > 0 &&
      !predictionSegment.includes("/") &&
      decodedRunId.length <= 255 &&
      /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/u.test(decodedRunId)) ||
    /^\/api\/eqo\/market-data\/datasets\/[A-Za-z0-9._-]{1,128}\/bars$/u.test(pathname)
  );
}

function unavailableResponse(status: number, error: string): NextResponse {
  return NextResponse.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  );
}

/**
 * Guard a fixed route before it authenticates or contacts any downstream.
 * A wrong but valid instance mode is indistinguishable from a missing route.
 */
export function requireRuntimeMode(
  expected: NativeRuntimeMode,
  _request?: Request,
): NextResponse | null {
  const status = nativeRuntimeReadiness();
  if (status.mode === null) return unavailableResponse(503, "runtime_unavailable");
  if (status.mode !== expected) return unavailableResponse(404, "not_found");
  if (!status.ready) return unavailableResponse(503, "runtime_unavailable");
  return null;
}

function validPublicOrigin(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== raw ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Navigation-only NativeResearch origin; a port change alone is not isolation. */
export function nativeResearchPublicOrigin(): string | null {
  if (getNativeRuntimeMode() !== "terminal" || !nativeRuntimeReadiness().ready) return null;
  const current = validPublicOrigin(publicAppOrigin() ?? undefined);
  const research = validPublicOrigin(process.env.EQO_RESEARCH_PUBLIC_ORIGIN);
  if (!current || !research || current.hostname.toLowerCase() === research.hostname.toLowerCase())
    return null;
  return research.origin;
}
