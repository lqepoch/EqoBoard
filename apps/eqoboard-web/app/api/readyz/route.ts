import {
  isLocalWorkstationRequestAllowed,
  isOidcConfigured,
  localWorkstationModeEnabled,
  localWorkstationModeRequested,
} from "@/auth";
import { noStoreJson } from "@/lib/server/bff-security";
import { nativeRuntimeReadiness } from "@/lib/server/runtime-mode";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const localMode = localWorkstationModeRequested();
  const identityConfigured = localMode
    ? localWorkstationModeEnabled() && isLocalWorkstationRequestAllowed(request)
    : isOidcConfigured();
  const runtime = nativeRuntimeReadiness();
  const ready = identityConfigured && runtime.ready;
  return noStoreJson(
    {
      status: ready ? "ready" : "unavailable",
      identity_configured: identityConfigured,
      runtime_mode: runtime.mode ?? "unknown",
      runtime_profile_isolated: runtime.profileIsolated,
      market_data: "not_checked",
      execution: "disabled",
    },
    ready ? 200 : 503,
  );
}
