import type {
  EngineStatusResponseV1,
  SyntheticOfflinePreviewV1,
} from "@lqepoch/trading-core-contracts";
import { hasControlCharacters } from "./text";

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function label(value: unknown, maximum = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasControlCharacters(value)
  );
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** The BFF parses Core ProtoJSON; this guard checks only the generated client shape and safety flags. */
export function parseEngineStatus(value: unknown): EngineStatusResponseV1 | null {
  const status = record(value);
  if (
    status?.$typeName !== "lqepoch.engine.v1.EngineStatusResponseV1" ||
    status.apiVersion !== "v1" ||
    !label(status.service) ||
    !label(status.serviceReadiness) ||
    status.sourceReadiness !== "unknown" ||
    status.mode !== "synthetic_offline" ||
    status.executionEnabled !== false ||
    status.mutationRoutesEnabled !== false ||
    !Number.isSafeInteger(status.schemaVersion) ||
    !count(status.pendingUnknownCount) ||
    typeof status.pendingUnknownCountCapped !== "boolean" ||
    !count(status.pendingUnknownConsumedRiskCount) ||
    !count(status.pendingUnknownUnverifiedRiskCount)
  )
    return null;
  return value as EngineStatusResponseV1;
}

/** Does not infer Engine readiness; rejects any response that signals account or market connectivity. */
export function parseSyntheticOfflinePreview(value: unknown): SyntheticOfflinePreviewV1 | null {
  const preview = record(value);
  if (
    preview?.$typeName !== "lqepoch.engine.v1.SyntheticOfflinePreviewV1" ||
    preview.sourceMode !== "synthetic_offline" ||
    preview.sourceProvenance !== "synthetic_only" ||
    preview.executionEnabled !== false ||
    preview.orderMutationsEnabled !== false ||
    preview.accountDataLoaded !== false ||
    preview.marketDataConnected !== false ||
    !count(preview.pendingUnknownCount) ||
    typeof preview.pendingUnknownCountCapped !== "boolean" ||
    !count(preview.pendingUnknownConsumedRiskCount) ||
    !count(preview.pendingUnknownUnverifiedRiskCount) ||
    !label(preview.disposition)
  )
    return null;
  return value as SyntheticOfflinePreviewV1;
}
