import { PinePluginError } from "./contract.mjs";

/**
 * Adapter to LuxAlgo's existing PineTS runtime. The host injects the pinned
 * constructor from a separately licensed, isolated installation.
 *
 * This file deliberately does NOT import, vendor, or execute pinets itself.
 * Commercial/AGPL licensing must be resolved before use.
 */
export function createPineTsAdapter({ PineTS, licenseApproved, isolatedProcess }) {
  if (licenseApproved !== true) {
    throw new PinePluginError("LICENSE_REQUIRED", "PineTS licensing has not been approved for this deployment.");
  }
  if (isolatedProcess !== true) {
    throw new PinePluginError("ISOLATION_REQUIRED", "PineTS must run in a supervised isolated process.");
  }
  if (typeof PineTS !== "function") {
    throw new PinePluginError("ENGINE_UNAVAILABLE", "A pinned PineTS constructor is required.");
  }
  return Object.freeze({
    id: "pinets",
    async evaluate({ source, candles }) {
      // The external sandbox must enforce real CPU/memory/wallclock limits,
      // egress=deny, no secrets, and termination on timeout.
      const runtime = new PineTS(candles);
      const output = await runtime.run(source);
      if (!output || typeof output !== "object") {
        throw new PinePluginError("ENGINE_FAILURE", "PineTS produced no output.");
      }
      return output;
    },
  });
}
