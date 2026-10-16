import "server-only";

import { noStoreJson } from "./bff-security";
import { consumePrincipalRateLimit, consumeServiceRateLimit } from "./rate-limit";
import type { ServerPrincipal } from "./auth";

export function portfolioLimitResponse(principal: ServerPrincipal) {
  const service = consumeServiceRateLimit("portfolio", 1_200, 60_000);
  if (!service.allowed)
    return noStoreJson({ error: "rate_limit_exceeded" }, 429, {
      "Retry-After": String(service.retryAfterSeconds),
    });
  const owner = consumePrincipalRateLimit(principal, {
    bucket: "portfolio",
    maxRequests: 120,
    windowMs: 60_000,
  });
  if (!owner.allowed)
    return noStoreJson({ error: "rate_limit_exceeded" }, 429, {
      "Retry-After": String(owner.retryAfterSeconds),
    });
  return null;
}

export function isEmptyReadRequest(request: Request): boolean {
  const url = new URL(request.url);
  const contentLength = request.headers.get("content-length");
  if (request.body !== null) {
    void request.body.cancel().catch(() => undefined);
    return false;
  }
  return (
    url.search === "" &&
    (contentLength === null || contentLength === "0") &&
    !request.headers.has("content-encoding") &&
    !request.headers.has("transfer-encoding")
  );
}

export function numericPathId(value: string): number | null {
  if (!/^[1-9][0-9]{0,14}$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
