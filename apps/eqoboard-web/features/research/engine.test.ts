import { describe, expect, it } from "vitest";

import { parseEngineStatus, parseSyntheticOfflinePreview } from "./engine";

const status = {
  $typeName: "lqepoch.engine.v1.EngineStatusResponseV1",
  apiVersion: "v1",
  service: "offline-persist-preview",
  serviceReadiness: "read_only_ready",
  sourceReadiness: "unknown",
  mode: "synthetic_offline",
  executionEnabled: false,
  mutationRoutesEnabled: false,
  schemaVersion: 15,
  pendingUnknownCount: 1,
  pendingUnknownCountCapped: false,
  pendingUnknownConsumedRiskCount: 1,
  pendingUnknownUnverifiedRiskCount: 0,
};

const preview = {
  $typeName: "lqepoch.engine.v1.SyntheticOfflinePreviewV1",
  sourceMode: "synthetic_offline",
  sourceProvenance: "synthetic_only",
  executionEnabled: false,
  orderMutationsEnabled: false,
  accountDataLoaded: false,
  marketDataConnected: false,
  pendingUnknownCount: 1,
  pendingUnknownCountCapped: false,
  pendingUnknownConsumedRiskCount: 1,
  pendingUnknownUnverifiedRiskCount: 0,
  disposition: "reconciliation_required",
};

describe("Engine offline read guards", () => {
  it("accepts Core generated synthetic and source-unknown response shapes", () => {
    expect(parseEngineStatus(status)?.sourceReadiness).toBe("unknown");
    expect(parseSyntheticOfflinePreview(preview)?.sourceProvenance).toBe("synthetic_only");
  });

  it("rejects connected or executable states before rendering diagnostics", () => {
    expect(parseEngineStatus({ ...status, executionEnabled: true })).toBeNull();
    expect(parseEngineStatus({ ...status, sourceReadiness: "ready" })).toBeNull();
    expect(parseSyntheticOfflinePreview({ ...preview, accountDataLoaded: true })).toBeNull();
    expect(parseSyntheticOfflinePreview({ ...preview, orderMutationsEnabled: true })).toBeNull();
    expect(parseSyntheticOfflinePreview({ ...preview, sourceProvenance: "provider" })).toBeNull();
  });
});
