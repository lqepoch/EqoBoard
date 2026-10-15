import "server-only";

import { createHash } from "node:crypto";
import type { ServerPrincipal } from "./auth";

const MAX_TOTAL_STREAMS = 100;
const MAX_STREAMS_PER_PRINCIPAL = 2;
const MAX_PRINCIPALS = 5_000;
const activeByPrincipal = new Map<string, number>();
let activeTotal = 0;

/** Process-local cap; a deployment-wide connection ceiling belongs at ingress. */
export function acquireLiveStreamSlot(principal: ServerPrincipal): (() => void) | null {
  const key = createHash("sha256")
    .update(principal.identityIssuer)
    .update("\0")
    .update(principal.subject)
    .digest("hex");
  const current = activeByPrincipal.get(key) ?? 0;
  if (activeTotal >= MAX_TOTAL_STREAMS || current >= MAX_STREAMS_PER_PRINCIPAL ||
      (!activeByPrincipal.has(key) && activeByPrincipal.size >= MAX_PRINCIPALS)) return null;
  activeTotal += 1;
  activeByPrincipal.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTotal -= 1;
    const remaining = (activeByPrincipal.get(key) ?? 1) - 1;
    if (remaining <= 0) activeByPrincipal.delete(key);
    else activeByPrincipal.set(key, remaining);
  };
}

export function resetLiveStreamBudgetForTests(): void {
  activeByPrincipal.clear();
  activeTotal = 0;
}
