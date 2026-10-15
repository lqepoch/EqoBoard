import "server-only";

import { isIP } from "node:net";
import { readBoundedResponse } from "./gateway";

export type UpstreamDeadline = Readonly<{
  signal: AbortSignal;
  timedOut(): boolean;
  close(): void;
}>;

export type JsonResponseRead =
  | Readonly<{ ok: true; bytes: Uint8Array; value: unknown }>
  | Readonly<{ ok: false; tooLarge: boolean }>;

const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validDnsHost(hostname: string): boolean {
  if (
    hostname.length < 1 ||
    hostname.length > 253 ||
    hostname.endsWith(".") ||
    isIP(hostname) !== 0
  )
    return false;
  return hostname
    .split(".")
    .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
}

/** Parse only a configured origin. Callers select their exact HTTP service allowlist. */
export function parseFixedServiceBaseUrl(
  raw: string | undefined,
  allowedHttpHosts: ReadonlySet<string>,
): URL | null {
  if (!raw || raw.length > 2_048 || raw.trim() !== raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.port && (!/^\d+$/u.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65_535))
      return null;
    const hostname = url.hostname.toLowerCase();
    if (url.protocol === "https:") {
      if (!validDnsHost(hostname)) return null;
    } else if (url.protocol === "http:") {
      if (!LOOPBACK_HTTP_HOSTS.has(hostname) && !allowedHttpHosts.has(hostname)) return null;
    } else {
      return null;
    }
    if (raw !== url.origin && raw !== `${url.origin}/`) return null;
    return new URL(url.origin);
  } catch {
    return null;
  }
}

export function mdpBaseUrl(): URL | null {
  return parseFixedServiceBaseUrl(process.env.EQO_MDP_URL, new Set(["market-data-platform"]));
}

export function quantResearchBaseUrl(): URL | null {
  return parseFixedServiceBaseUrl(process.env.EQO_QUANT_RESEARCH_URL, new Set(["quant-research"]));
}

/** Engine must share the app's host/network namespace and remain loopback-only. */
export function engineBaseUrl(): URL | null {
  const raw = process.env.EQO_ENGINE_URL;
  if (!raw || raw.length > 2_048 || raw.trim() !== raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (raw !== url.origin && raw !== `${url.origin}/`)
    )
      return null;
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? new URL(url.origin) : null;
  } catch {
    return null;
  }
}

export function createUpstreamDeadline(request: Request, timeoutMs: number): UpstreamDeadline {
  const controller = new AbortController();
  let deadlineExpired = false;
  const onClientAbort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) controller.abort(request.signal.reason);
  else request.signal.addEventListener("abort", onClientAbort, { once: true });
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new Error("upstream_deadline"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => deadlineExpired,
    close: () => {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onClientAbort);
    },
  };
}

export async function readJsonResponseBounded(
  response: Response,
  maxBytes: number,
): Promise<JsonResponseRead> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, tooLarge: false };
  }
  const result = await readBoundedResponse(response, maxBytes);
  if (!result.ok) return { ok: false, tooLarge: result.reason === "too_large" };
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
    ) as unknown;
    return { ok: true, bytes: result.bytes, value };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

export function passthroughJsonResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
