import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import type { MarketStore } from "../../stores/market/market-store";

type BackgroundServices = Readonly<{
  store: Pick<MarketStore, "setTransport">;
  attachStream: () => () => void;
  startLeases: () => void;
  stopLeases: () => void;
}>;

function hasPermission(
  auth: AuthUiSnapshot,
  permission: "market:stream" | "market:subscribe",
): boolean {
  return auth.authenticated && auth.permissions.includes(permission);
}

/** Starts the terminal-only background transports once for the shared host. */
export function startMarketHostBackgroundServices(
  auth: AuthUiSnapshot,
  services: BackgroundServices,
): () => void {
  if (auth.runtimeMode === "research") {
    services.store.setTransport("unavailable");
    return () => undefined;
  }

  let streamCleanup: (() => void) | null = null;
  let leasesStarted = false;
  if (hasPermission(auth, "market:stream")) streamCleanup = services.attachStream();
  else services.store.setTransport("unavailable", "stream-unavailable");

  if (hasPermission(auth, "market:subscribe")) {
    services.startLeases();
    leasesStarted = true;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    streamCleanup?.();
    streamCleanup = null;
    if (leasesStarted) services.stopLeases();
  };
}
