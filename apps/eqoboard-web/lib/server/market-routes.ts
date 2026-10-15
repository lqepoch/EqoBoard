import "server-only";

import { NextResponse } from "next/server";
import type { Permission } from "../contracts/auth";
import { authorizeGatewayRequest, noStoreJson, readBoundedJson } from "./bff-security";
import { fetchGateway, relayGatewayJson, type GatewayPath } from "./gateway";

export const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,11}$/u;
export const OCC_PATTERN = /^[A-Z0-9]{1,6}\d{6}[CP]\d{8}$/u;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function routeError(status: number, error: string): NextResponse {
  return noStoreJson({ error }, status);
}

export async function getGatewayJson(
  request: Request,
  permission: Permission,
  path: GatewayPath,
  query: Readonly<Record<string, string>> = {},
  maxBytes?: number,
): Promise<NextResponse> {
  const authorization = await authorizeGatewayRequest(request, permission);
  if (!authorization.ok) return authorization.response;
  const upstream = await fetchGateway(request, path, {
    token: authorization.token,
    query,
    timeoutMs: 12_000,
  });
  if (!upstream.ok) {
    if (upstream.error === "gateway_timeout") return routeError(504, "gateway_timeout");
    return routeError(503, "gateway_unavailable");
  }
  return relayGatewayJson(upstream.response, maxBytes);
}

export async function postGatewayJson(
  request: Request,
  permission: Permission,
  path: GatewayPath,
  parseBody: (
    value: unknown,
  ) => Readonly<{ ok: true; body: unknown }> | Readonly<{ ok: false; error: string }>,
): Promise<NextResponse> {
  const authorization = await authorizeGatewayRequest(request, permission);
  if (!authorization.ok) return authorization.response;
  const bounded = await readBoundedJson(request, 64 * 1024);
  if (!bounded.ok) return bounded.response;
  const parsed = parseBody(bounded.value);
  if (!parsed.ok) return routeError(400, parsed.error);
  const upstream = await fetchGateway(request, path, {
    method: "POST",
    token: authorization.token,
    body: JSON.stringify(parsed.body),
    timeoutMs: 12_000,
  });
  if (!upstream.ok) {
    if (upstream.error === "gateway_timeout") return routeError(504, "gateway_timeout");
    return routeError(503, "gateway_unavailable");
  }
  return relayGatewayJson(upstream.response);
}
