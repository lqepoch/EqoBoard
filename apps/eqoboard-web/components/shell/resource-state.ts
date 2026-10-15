export const RESOURCE_STATE_LABELS = {
  ready: "Ready",
  fresh: "Fresh",
  unknown: "Unknown",
  idle: "Idle",
  loading: "Loading",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  partial: "Partial",
  stale: "Stale",
  synthetic: "Synthetic",
  error: "Error",
  unavailable: "Unavailable",
  unsupported: "Unsupported",
  restricted: "Restricted",
} as const;

export type ResourceStateKind = keyof typeof RESOURCE_STATE_LABELS;

export function getResourceStateLabel(state: ResourceStateKind): string {
  return RESOURCE_STATE_LABELS[state];
}
