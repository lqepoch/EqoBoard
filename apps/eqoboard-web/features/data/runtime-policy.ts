import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import type { NativeDataOperationId } from "./operations";

const RESEARCH_MODE_READ_ALLOWLIST: ReadonlySet<NativeDataOperationId> = new Set([
  "market.archive.diagnostic-bars",
  "research.yahoo.daily",
  "research.predictions",
]);

// These research provider adapters belong to the terminal host, which can
// satisfy both its research role and the additional market-read gate for recap.
const TERMINAL_ONLY_RESEARCH_READS: ReadonlySet<NativeDataOperationId> = new Set([
  "research.recap",
  "research.symbolSearch",
]);

/**
 * Browser routing metadata is not authorization, but it prevents the wrong
 * same-origin runtime from dispatching to an endpoint that its BFF must hide.
 * The server still authenticates and authorizes every request.
 */
export function isNativeReadAllowedInRuntime(
  operationId: NativeDataOperationId,
  runtimeMode: AuthUiSnapshot["runtimeMode"],
): boolean {
  const mode = runtimeMode ?? "terminal";
  if (mode === "research") {
    return (
      !TERMINAL_ONLY_RESEARCH_READS.has(operationId) &&
      RESEARCH_MODE_READ_ALLOWLIST.has(operationId)
    );
  }
  return operationId !== "research.yahoo.daily";
}

export function isTerminalMarketRuntime(auth: AuthUiSnapshot): boolean {
  return auth.runtimeMode !== "research";
}
