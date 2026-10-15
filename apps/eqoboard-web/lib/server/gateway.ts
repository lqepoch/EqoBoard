import "server-only";

import { isIP } from "node:net";
import { NextResponse } from "next/server";

export const GATEWAY_PATHS = [
  "/api/v1/status",
  "/api/v1/stocks/snapshots",
  "/api/v1/stocks/bars",
  "/api/v1/options/chain",
  "/api/v1/subscriptions/stocks",
  "/api/v1/subscriptions/options",
  "/api/v1/orders/preview",
  "/api/v1/stream/sse",
] as const;

export type GatewayPath = (typeof GATEWAY_PATHS)[number];

export type GatewayFetchOptions = Readonly<{
  method?: "GET" | "POST";
  token: string;
  query?: Readonly<Record<string, string>>;
  body?: string;
  accept?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type GatewayFetchResult =
  | Readonly<{ ok: true; response: Response }>
  | Readonly<{
      ok: false;
      error: "gateway_unavailable" | "gateway_redirect_rejected" | "gateway_timeout";
    }>;

const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const ALLOWED_HTTP_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "gateway",
  "native-mock-gateway",
]);

function validDnsName(value: string): boolean {
  if (value.length < 1 || value.length > 253 || value.endsWith(".") || isIP(value) !== 0)
    return false;
  return value
    .split(".")
    .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
}

export function parseGatewayBaseUrl(raw: string | undefined): URL | null {
  const value = raw ?? "http://127.0.0.1:8080";
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.port && (!/^\d+$/u.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65_535))
      return null;
    if (url.protocol === "http:") {
      if (!ALLOWED_HTTP_HOSTS.has(url.hostname.toLowerCase())) return null;
    } else if (url.protocol === "https:") {
      if (!validDnsName(url.hostname)) return null;
    } else {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function gatewayUrl(
  path: GatewayPath,
  query: Readonly<Record<string, string>> = {},
): URL | null {
  if (!(GATEWAY_PATHS as readonly string[]).includes(path)) return null;
  const base = parseGatewayBaseUrl(process.env.EQO_RUST_URL);
  if (!base) return null;
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

export async function fetchGateway(
  request: Request,
  path: GatewayPath,
  options: GatewayFetchOptions,
): Promise<GatewayFetchResult> {
  const url = gatewayUrl(path, options.query);
  if (!url) return { ok: false, error: "gateway_unavailable" };
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs! >= 1_000 &&
    options.timeoutMs! <= 60_000
      ? options.timeoutMs!
      : 12_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([request.signal, options.signal, timeout])
    : AbortSignal.any([request.signal, timeout]);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        accept: options.accept ?? "application/json",
        authorization: `Bearer ${options.token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body,
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: "gateway_redirect_rejected" };
    }
    return { ok: true, response };
  } catch (error) {
    const timeoutHit = timeout.aborted && !request.signal.aborted && !options.signal?.aborted;
    return { ok: false, error: timeoutHit ? "gateway_timeout" : "gateway_unavailable" };
  }
}

export type BoundedResponseResult =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; reason: "too_large" | "invalid_body" }>;

export async function readBoundedResponse(
  response: Response,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<BoundedResponseResult> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }
  if (!response.body) return { ok: true, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "invalid_body" };
  } finally {
    reader.releaseLock();
  }
}

export async function relayGatewayJson(
  response: Response,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<NextResponse> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return NextResponse.json(
      { error: "invalid_gateway_response" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await readBoundedResponse(response, maxBytes);
  if (!body.ok) {
    return NextResponse.json(
      {
        error:
          body.reason === "too_large" ? "gateway_response_too_large" : "invalid_gateway_response",
      },
      {
        status: body.reason === "too_large" ? 502 : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)) as unknown;
  } catch {
    return NextResponse.json(
      { error: "invalid_gateway_response" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new NextResponse(body.bytes, {
    status: response.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
