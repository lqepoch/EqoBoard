import "server-only";

import { createHash } from "node:crypto";
import type { ServerPrincipal } from "./auth";

const MAX_BUCKETS = 5_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

export type PrincipalRateLimit = Readonly<{
  bucket: string;
  maxRequests: number;
  windowMs: number;
}>;

export type PrincipalRateLimitResult = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

function consumeKeyedRateLimit(
  key: string,
  options: Pick<PrincipalRateLimit, "maxRequests" | "windowMs">,
  now: number,
): PrincipalRateLimitResult {
  for (const [candidate, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(candidate);
  }
  let entry = buckets.get(key);
  if (!entry) {
    if (buckets.size >= MAX_BUCKETS) return { allowed: false, retryAfterSeconds: 60 };
    entry = { count: 0, resetAt: now + options.windowMs };
    buckets.set(key, entry);
  }
  if (entry.count >= options.maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)) };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Process-local bounded limiter; deployments with multiple instances need a shared store. */
export function consumePrincipalRateLimit(
  principal: ServerPrincipal,
  options: PrincipalRateLimit,
  now = Date.now(),
): PrincipalRateLimitResult {
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/iu.test(options.bucket) ||
      !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 100_000 ||
      !Number.isSafeInteger(options.windowMs) || options.windowMs < 1_000 || options.windowMs > 24 * 60 * 60 * 1_000) {
    return { allowed: false, retryAfterSeconds: 60 };
  }
  const principalKey = createHash("sha256")
    .update(principal.identityIssuer)
    .update("\0")
    .update(principal.subject)
    .digest("hex");
  const key = `${options.bucket}:${principalKey}`;

  return consumeKeyedRateLimit(key, options, now);
}

/** Process-wide service ceiling in addition to the per-principal bucket. */
export function consumeServiceRateLimit(
  bucket: string,
  maxRequests: number,
  windowMs: number,
  now = Date.now(),
): PrincipalRateLimitResult {
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/iu.test(bucket) ||
      !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1_000_000 ||
      !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 24 * 60 * 60 * 1_000) {
    return { allowed: false, retryAfterSeconds: 60 };
  }
  return consumeKeyedRateLimit(`service:${bucket}`, { maxRequests, windowMs }, now);
}

/** Only for test isolation; production callers should never need to reset counters. */
export function clearProcessRateLimitsForTests(): void {
  buckets.clear();
}
