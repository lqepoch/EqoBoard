"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import { MarketStore, type MarketFeedName, type MarketHostSnapshot } from "../../stores/market/market-store";
import type { WidgetLifecycle, WidgetRefreshPolicyV1 } from "../../widgets/sdk/contracts";
import type { WidgetActionClient } from "../../widgets/sdk/actions";
import type { WidgetDataClient, WidgetMarketReader, WidgetRefreshScheduler } from "../../widgets/sdk/data";
import { createWidgetPollBudget } from "../../widgets/sdk/pollBudget";
import type { WidgetPollBudget } from "../../widgets/sdk/pollBudget";
import { createNativeActionClient } from "./action-client";
import { attachMarketEventStream } from "./market-stream";
import { createNativeRefreshScheduler, type RefreshScope } from "./refresh-scheduler";
import { createNativeDataReadClient, readNativeJsonResponse } from "./read-client";
import { MarketLeaseCoordinator, type OptionsLeaseInput, type StockLeaseInput } from "./lease-coordinator";
import type { NativeActionMap, NativeDataOperationMap } from "./operations";
import { startMarketHostBackgroundServices } from "./market-runtime";
import { isTerminalMarketRuntime } from "./runtime-policy";

const POLL_BUDGET = Object.freeze({
  maxConcurrentGlobal: 8,
  maxConcurrentPerOperation: 3,
  maxConcurrentPerWidget: 1 as const,
  maxRequestsPerMinuteGlobal: 120,
  maxRequestsPerMinutePerUser: 90,
  maxRequestsPerMinutePerOperation: 30,
  maxRequestsPerMinutePerWidget: 30,
  minimumIntervalMs: 1_000,
});

export type MarketDataHostServices = Readonly<{
  auth: AuthUiSnapshot;
  data: WidgetDataClient<NativeDataOperationMap>;
  actions: WidgetActionClient<NativeActionMap>;
  market: WidgetMarketReader<MarketHostSnapshot>;
  store: MarketStore;
  pollBudget: WidgetPollBudget;
  leaseCoordinator: MarketLeaseCoordinator;
  canSubscribe: boolean;
}>;

const MarketDataContext = createContext<MarketDataHostServices | null>(null);

function permissionsKey(auth: AuthUiSnapshot): string {
  return `${auth.runtimeMode ?? "terminal"}:${auth.authenticated}:${auth.status}:${auth.storagePartition ?? "anonymous"}:${[...auth.permissions].sort().join(",")}`;
}

function hasPermission(auth: AuthUiSnapshot, permission: string): boolean {
  return auth.authenticated && auth.permissions.includes(permission as never);
}

class MarketDataRuntime {
  readonly store = new MarketStore();
  readonly pollBudget = createWidgetPollBudget(POLL_BUDGET);
  readonly data: WidgetDataClient<NativeDataOperationMap>;
  readonly actions: WidgetActionClient<NativeActionMap>;
  readonly market: WidgetMarketReader<MarketHostSnapshot>;
  readonly leaseCoordinator: MarketLeaseCoordinator;
  #auth: AuthUiSnapshot;
  #identityKey: string;
  #runtimeModeKey: NonNullable<AuthUiSnapshot["runtimeMode"]>;
  #pendingIdentityReset = false;
  #pendingRuntimeReset = false;
  #backgroundCleanup: (() => void) | null = null;
  #freshnessTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;

  constructor(auth: AuthUiSnapshot) {
    this.#auth = auth;
    this.#identityKey = auth.storagePartition ?? "anonymous";
    this.#runtimeModeKey = auth.runtimeMode ?? "terminal";
    const getAuth = () => this.#auth;
    this.data = createNativeDataReadClient(getAuth);
    this.actions = createNativeActionClient(getAuth);
    this.market = Object.freeze({ getSnapshot: this.store.getSnapshot, subscribe: this.store.subscribe });
    this.leaseCoordinator = new MarketLeaseCoordinator(this.store, (feed, input, signal, keepalive) =>
      this.#sendLease(feed, input, signal, keepalive));
  }

  getServices(): MarketDataHostServices {
    return Object.freeze({
      auth: this.#auth,
      data: this.data,
      actions: this.actions,
      market: this.market,
      store: this.store,
      pollBudget: this.pollBudget,
      leaseCoordinator: this.leaseCoordinator,
      canSubscribe: isTerminalMarketRuntime(this.#auth) && hasPermission(this.#auth, "market:subscribe"),
    });
  }

  updateAuth(auth: AuthUiSnapshot): void {
    const nextIdentity = auth.storagePartition ?? "anonymous";
    const nextRuntimeMode = auth.runtimeMode ?? "terminal";
    if (this.#identityKey !== nextIdentity) {
      this.#pendingIdentityReset = true;
      this.#identityKey = nextIdentity;
    }
    if (this.#runtimeModeKey !== nextRuntimeMode) {
      this.#pendingRuntimeReset = true;
      this.#runtimeModeKey = nextRuntimeMode;
    }
    this.#auth = auth;
  }

  start(): () => void {
    if (this.#started) return () => this.stop();
    this.#started = true;
    if (this.#pendingIdentityReset || this.#pendingRuntimeReset) {
      this.store.resetForIdentityBoundary();
      this.#pendingIdentityReset = false;
      this.#pendingRuntimeReset = false;
    }
    this.#backgroundCleanup = startMarketHostBackgroundServices(this.#auth, {
      store: this.store,
      attachStream: () => attachMarketEventStream(this.store),
      startLeases: () => this.leaseCoordinator.start(),
      stopLeases: () => this.leaseCoordinator.stop(),
    });
    if (isTerminalMarketRuntime(this.#auth)) this.#freshnessTimer = setInterval(() => this.store.tick(), 1_000);
    return () => this.stop();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#backgroundCleanup?.();
    this.#backgroundCleanup = null;
    if (this.#freshnessTimer) clearInterval(this.#freshnessTimer);
    this.#freshnessTimer = null;
  }

  async #sendLease(
    feed: MarketFeedName,
    input: StockLeaseInput | OptionsLeaseInput,
    signal: AbortSignal,
    keepalive = false,
  ): Promise<unknown> {
    if (!isTerminalMarketRuntime(this.#auth) || !hasPermission(this.#auth, "market:subscribe")) throw new Error("unavailable");
    const path = feed === "stocks" ? "/api/eqo/stocks/subscribe" : "/api/eqo/options/subscribe";
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).byteLength > 64 * 1024) throw new Error("unavailable");
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
      redirect: "error",
      keepalive,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body,
      signal,
    });
    return readNativeJsonResponse(response, 256 * 1024, signal);
  }
}

export type MarketDataHostProps = Readonly<{ auth: AuthUiSnapshot; children: ReactNode }>;

/** Installs the single same-origin market stream and shared bounded data clients. */
export function MarketDataHost({ auth, children }: MarketDataHostProps) {
  const [runtime] = useState(() => new MarketDataRuntime(auth));
  runtime.updateAuth(auth);
  const services = runtime.getServices();
  const authKey = permissionsKey(auth);

  useEffect(() => runtime.start(), [runtime, authKey]);

  return <MarketDataContext.Provider value={services}>{children}</MarketDataContext.Provider>;
}

function useMarketDataHost(): MarketDataHostServices {
  const services = useContext(MarketDataContext);
  if (!services) throw new Error("MarketDataHost is not mounted.");
  return services;
}

/** Stable host-owned closed read client for each widget's WidgetHostContext.data slot. */
export function useWidgetDataClient(): WidgetDataClient<NativeDataOperationMap> {
  return useMarketDataHost().data;
}

/** Host-owned closed POST actions; there is no submit/live action ID. */
export function useWidgetActionClient(): WidgetActionClient<NativeActionMap> {
  return useMarketDataHost().actions;
}

/** Shared read-only Gateway selectors for each widget's WidgetHostContext.market slot. */
export function useMarketDataReader(): WidgetMarketReader<MarketHostSnapshot> {
  return useMarketDataHost().market;
}

/** Snapshot hook for first-party market widgets. */
export function useMarketDataSnapshot(): MarketHostSnapshot {
  const { store } = useMarketDataHost();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Per-widget poll observer factory bound to the manifest ceiling and shared host budget. */
export function useWidgetRefreshScheduler(
  policy: WidgetRefreshPolicyV1,
  lifecycle: WidgetLifecycle,
  scope: RefreshScope,
): WidgetRefreshScheduler<NativeDataOperationMap> {
  const services = useMarketDataHost();
  const scopeKey = services.auth.storagePartition ?? "anonymous";
  return useMemo(() => createNativeRefreshScheduler(
    services.data,
    policy,
    lifecycle,
    scope,
    services.pollBudget,
    scopeKey,
  ), [services.data, services.pollBudget, policy, lifecycle, scope.instanceId, scope.hidden, scopeKey]);
}

/** Widgets publish desired symbols; the host unions them into one Gateway lease per feed. */
export function useMarketLease(
  instanceId: string,
  feed: "stocks" | "options",
  symbols: readonly string[],
  lifecycle: WidgetLifecycle,
): void {
  const { leaseCoordinator, canSubscribe, auth } = useMarketDataHost();
  const symbolsKey = JSON.stringify(symbols);
  useEffect(() => {
    const sync = () => {
      if (canSubscribe && lifecycle.getSnapshot().phase === "active") {
        leaseCoordinator.setConsumer(instanceId, feed, symbols);
      } else {
        leaseCoordinator.removeConsumer(instanceId, feed);
      }
    };
    sync();
    const unsubscribe = lifecycle.subscribe(sync);
    return () => {
      unsubscribe();
      leaseCoordinator.removeConsumer(instanceId, feed);
    };
  }, [leaseCoordinator, canSubscribe, auth.storagePartition, instanceId, feed, symbolsKey, lifecycle]);
}
