import { describe, expect, it } from "vitest";
import { getResourceStateLabel, type ResourceStateKind } from "./resource-state";

describe("resource state labels", () => {
  it("keeps every state explicit in text for non-color status communication", () => {
    const states: readonly ResourceStateKind[] = [
      "ready", "fresh", "unknown", "idle", "loading", "connecting", "connected", "reconnecting",
      "partial", "stale", "synthetic", "error", "unavailable", "unsupported", "restricted",
    ];

    expect(states.map(getResourceStateLabel)).toEqual([
      "Ready", "Fresh", "Unknown", "Idle", "Loading", "Connecting", "Connected", "Reconnecting",
      "Partial", "Stale", "Synthetic", "Error", "Unavailable", "Unsupported", "Restricted",
    ]);
  });
});
