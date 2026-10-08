import { randomUUID } from "node:crypto";
import {
  parseEngineStatusResponseV1ProtoJsonText,
  parseSyntheticOfflinePreviewV1ProtoJsonText,
  type EngineStatusResponseV1,
  type SyntheticOfflinePreviewV1,
} from "@lqepoch/trading-core-contracts";
import { NextResponse, type NextRequest } from "next/server";
import { authorizeEngineOfflinePreviewRequest, researchModeRouteUnavailable } from "@/lib/eqo-auth";
import { readLimitedResponse } from "@/lib/http-response";

const MAX_ENGINE_RESPONSE_BYTES = 16 * 1024;
const ENGINE_REQUEST_DEADLINE_MS = 3_000;

export type EngineReadResource = "status" | "preview";
type EngineReadMessage = EngineStatusResponseV1 | SyntheticOfflinePreviewV1;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function engineBaseUrl(): URL | null {
  const raw = process.env.EQO_ENGINE_URL;
  if (!raw || raw.length > 2_048 || raw.trim() !== raw) return null;
  try {
    const base = new URL(raw);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port ||
        base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
        (raw !== base.origin && raw !== `${base.origin}/`)) return null;
    const port = Number(base.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return new URL(base.origin);
  } catch {
    return null;
  }
}

function validReadRequest(request: NextRequest): NextResponse | null {
  if (request.method !== "GET" || request.nextUrl.search !== "" ||
      request.headers.has("content-encoding") || request.headers.has("transfer-encoding") ||
      (request.headers.has("content-length") && request.headers.get("content-length") !== "0")) {
    void request.body?.cancel().catch(() => undefined);
    return jsonError(400, "invalid_request");
  }
  if (request.body !== null) {
    void request.body.cancel().catch(() => undefined);
    return jsonError(400, "invalid_request");
  }
  return null;
}

async function readEngineResponse(response: Response, resource: EngineReadResource): Promise<EngineReadMessage | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(MAX_ENGINE_RESPONSE_BYTES))) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const bytes = await readLimitedResponse(response, MAX_ENGINE_RESPONSE_BYTES);
    if (bytes === null) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return resource === "status"
      ? parseEngineStatusResponseV1ProtoJsonText(text)
      : parseSyntheticOfflinePreviewV1ProtoJsonText(text);
  } catch {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
}

/** Fixed, loopback-only GET proxy; upstream body remains the Core-owned ProtoJSON contract. */
export async function proxyEngineRead(request: NextRequest, resource: EngineReadResource): Promise<NextResponse> {
  const unavailable = researchModeRouteUnavailable();
  if (unavailable) return unavailable;
  const invalid = validReadRequest(request);
  if (invalid) return invalid;

  const authorization = await authorizeEngineOfflinePreviewRequest(request);
  if (!authorization.ok) return authorization.response;
  const base = engineBaseUrl();
  if (!base) return jsonError(503, "engine_service_unavailable");

  const controller = new AbortController();
  let deadlineExpired = false;
  const onClientAbort = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", onClientAbort, { once: true });
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, ENGINE_REQUEST_DEADLINE_MS);
  try {
    const upstream = await fetch(new URL(`/v1/${resource}`, base), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authorization.token}`,
        "X-Request-ID": randomUUID(),
      },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status !== 200) {
      void upstream.body?.cancel().catch(() => undefined);
      return upstream.status === 504 || deadlineExpired
        ? jsonError(504, "engine_query_timeout")
        : jsonError(503, "engine_service_unavailable");
    }
    const message = await readEngineResponse(upstream, resource);
    if (message === null) return deadlineExpired
      ? jsonError(504, "engine_query_timeout")
      : jsonError(502, "invalid_engine_response");
    // Core's parser returns the generated camelCase Message shape. Return that
    // exact type-only client contract, including $typeName and default fields,
    // instead of forwarding the upstream snake_case ProtoJSON as another shape.
    const serializedMessage = JSON.stringify(message);
    if (Buffer.byteLength(serializedMessage, "utf8") > MAX_ENGINE_RESPONSE_BYTES) {
      return jsonError(502, "invalid_engine_response");
    }
    return new NextResponse(serializedMessage, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return deadlineExpired
      ? jsonError(504, "engine_query_timeout")
      : jsonError(503, "engine_service_unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}

export function engineMethodNotAllowed(): NextResponse {
  const unavailable = researchModeRouteUnavailable();
  return unavailable ?? jsonError(405, "method_not_allowed");
}
