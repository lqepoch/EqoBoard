import type { NativeActionMap, NativeDataOperationMap } from "@/features/data/operations";
import type { Permission } from "@/lib/contracts/auth";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import type { WidgetManifestV1 } from "@/widgets/sdk/contracts";
import type { WidgetOperationMap } from "@/widgets/sdk/data";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import type {
  AnyWidgetRegistration,
  BuiltinProvenance,
  WidgetRegistration,
} from "@/widgets/registry/types";

import { FeedStatusWidget, OrderbookWidget, QuoteWidget, WatchlistWidget } from "./QuoteWidgets";
import {
  EMPTY_MARKET_CONFIG,
  createDefaultOptionExpiryConfig,
  parseEmptyMarketConfig,
  parseOptionExpiryConfig,
  type EmptyMarketConfigV1,
  type OptionExpiryConfigV1,
} from "./config";
import { OptionsChainWidget, IvSkewWidget, OptionTapeWidget } from "../options/OptionsWidgets";
import { VerticalPreviewWidget } from "./VerticalPreviewWidget";

const quoteOperations = ["market.quotes"] as const;
const optionOperations = ["market.quotes", "market.options.chain"] as const;
const noReads = [] as const;
const noActions = [] as const;
const previewActions = ["orders.preview.vertical"] as const;

const noRefresh = Object.freeze({ mode: "none" } as const);
const sharedRefresh = Object.freeze({ mode: "shared-market" } as const);
const snapshotRefresh = Object.freeze({
  mode: "poll",
  minIntervalMs: 30_000,
  maxRequestsPerMinute: 2,
  maxConcurrentRequests: 1,
  whenHidden: "pause",
} as const);
const optionsSnapshotRefresh = Object.freeze({
  mode: "poll",
  minIntervalMs: 30_000,
  // Options chain widgets make one bounded chain read and one underlying
  // snapshot read per interval. The poll budget is per widget across ops.
  maxRequestsPerMinute: 4,
  maxConcurrentRequests: 1,
  whenHidden: "pause",
} as const);

function manifest(
  id: string,
  title: string,
  description: string,
  configSchemaId: string,
  rendererId: string,
  defaultSize: WidgetManifestV1["defaultSize"],
  inputs: WidgetManifestV1["inputs"],
  requiredPermissions: WidgetManifestV1["requiredPermissions"],
  refresh: WidgetManifestV1["refresh"],
  symbolBinding: WidgetManifestV1["symbolBinding"],
  provenanceId: string,
  provenancePolicy: WidgetManifestV1["provenancePolicy"],
): WidgetManifestV1 {
  return Object.freeze({
    manifestVersion: 1,
    sdkVersion: 1,
    id,
    version: "1.0.0",
    title,
    description,
    category: "market",
    rendererId,
    configSchemaId,
    defaultSize,
    inputs,
    requiredPermissions,
    refresh,
    symbolBinding,
    provenanceId,
    provenancePolicy,
  });
}

function provenance(provenanceId: string, sourcePath: string): BuiltinProvenance {
  return Object.freeze({
    provenanceId,
    origin: "first-party",
    sourceRepository: "https://github.com/lqepoch/EqoBoard",
    sourcePath,
    sourceCommit: null,
    license: "MIT",
    noticePath: "LICENSE",
    auditReference: "native06-provenance.json",
  });
}

function emptyManifest(
  id: string,
  title: string,
  description: string,
  rendererId: string,
  size: WidgetManifestV1["defaultSize"],
  input: WidgetManifestV1["inputs"],
  permissions: readonly Permission[],
  refresh: WidgetManifestV1["refresh"],
  symbolBinding: WidgetManifestV1["symbolBinding"],
  provenanceId: string,
  evidence = true,
): WidgetManifestV1 {
  return manifest(
    id,
    title,
    description,
    `${id}.v1`,
    rendererId,
    size,
    input,
    Object.freeze([...permissions]),
    refresh,
    symbolBinding,
    provenanceId,
    evidence ? "surface-response-evidence" : "no-market-data",
  );
}

const SMALL_SIZE: WidgetManifestV1["defaultSize"] = Object.freeze({
  w: 4,
  h: 5,
  minW: 3,
  minH: 3,
  maxW: 12,
  maxH: 12,
});
const WIDE_SIZE: WidgetManifestV1["defaultSize"] = Object.freeze({
  w: 8,
  h: 7,
  minW: 4,
  minH: 4,
  maxW: 12,
  maxH: 12,
});
const LARGE_SIZE: WidgetManifestV1["defaultSize"] = Object.freeze({
  w: 10,
  h: 9,
  minW: 5,
  minH: 5,
  maxW: 12,
  maxH: 12,
});
const SYMBOL_INPUT = Object.freeze([
  { name: "symbol", kind: "symbol", source: "symbol-binding", required: true },
] as const);
const WATCHLIST_INPUT = Object.freeze([
  { name: "watchlist", kind: "symbol-list", source: "workspace.watchlist", required: true },
] as const);
const NO_INPUT = Object.freeze([] as const);

const quoteId = "market.quote";
const watchlistId = "market.watchlist";
const optionsId = "market.options-chain";
const ivId = "market.iv-skew";
const tapeId = "market.option-tape";
const feedId = "market.feed-status";
const depthId = "market.orderbook";
const previewId = "market.vertical-preview";

const quoteManifest = emptyManifest(
  quoteId,
  "Quote",
  "Provider snapshot values and Gateway events with explicit source and entitlement evidence.",
  "eqoboard.market.quote.v1",
  SMALL_SIZE,
  SYMBOL_INPUT,
  ["market:read", "market:stream", "market:subscribe"],
  snapshotRefresh,
  "active-or-fixed",
  "eqoboard.native06.market.quote.v1",
);
const watchlistManifest = emptyManifest(
  watchlistId,
  "Watchlist",
  "Bounded watchlist snapshots and shared Gateway stream updates.",
  "eqoboard.market.watchlist.v1",
  LARGE_SIZE,
  WATCHLIST_INPUT,
  ["market:read", "market:stream", "market:subscribe"],
  snapshotRefresh,
  "unsupported",
  "eqoboard.native06.market.watchlist.v1",
);
const optionsManifest = emptyManifest(
  optionsId,
  "Options chain",
  "Alpaca option-chain snapshots with reported Greeks and separately labeled Gateway quote events.",
  "eqoboard.market.options-chain.v1",
  LARGE_SIZE,
  SYMBOL_INPUT,
  ["market:read", "market:stream", "market:subscribe"],
  optionsSnapshotRefresh,
  "active-or-fixed",
  "eqoboard.native06.market.options-chain.v1",
);
const ivManifest = emptyManifest(
  ivId,
  "IV and Greeks",
  "Provider-returned per-contract implied volatility and Greeks without interpolation.",
  "eqoboard.market.iv-skew.v1",
  LARGE_SIZE,
  SYMBOL_INPUT,
  ["market:read", "market:stream", "market:subscribe"],
  optionsSnapshotRefresh,
  "active-or-fixed",
  "eqoboard.native06.market.iv-skew.v1",
);
const tapeManifest = emptyManifest(
  tapeId,
  "Option tape",
  "Trades from shared active option subscriptions; coverage and aggressor side remain unknown.",
  "eqoboard.market.option-tape.v1",
  WIDE_SIZE,
  SYMBOL_INPUT,
  ["market:stream"],
  sharedRefresh,
  "active-or-fixed",
  "eqoboard.native06.market.option-tape.v1",
);
const feedManifest = emptyManifest(
  feedId,
  "Feed status",
  "Shared Gateway transport, per-feed freshness, epoch and lease coverage.",
  "eqoboard.market.feed-status.v1",
  WIDE_SIZE,
  NO_INPUT,
  ["market:stream"],
  sharedRefresh,
  "unsupported",
  "eqoboard.native06.market.feed-status.v1",
);
const orderbookManifest = emptyManifest(
  depthId,
  "Order book",
  "Depth is unavailable until a typed provider depth source exists.",
  "eqoboard.market.orderbook.v1",
  SMALL_SIZE,
  NO_INPUT,
  [],
  noRefresh,
  "unsupported",
  "eqoboard.native06.market.orderbook.v1",
  false,
);
const previewManifest = emptyManifest(
  previewId,
  "Vertical preview",
  "Server-side Alpaca Paper vertical risk preview; order execution is disabled.",
  "eqoboard.market.vertical-preview.v1",
  WIDE_SIZE,
  NO_INPUT,
  ["orders:preview"],
  noRefresh,
  "unsupported",
  "eqoboard.native06.market.vertical-preview.v1",
);

export const quoteWidgetRegistration: WidgetRegistration<
  EmptyMarketConfigV1,
  Pick<NativeDataOperationMap, "market.quotes">,
  WidgetNoActionMap,
  MarketHostSnapshot
> = {
  manifest: quoteManifest,
  Component: QuoteWidget,
  allowedReadOperations: quoteOperations,
  allowedActions: noActions,
  parseConfig: parseEmptyMarketConfig,
  createDefaultConfig: () => EMPTY_MARKET_CONFIG,
  provenance: provenance(
    "eqoboard.native06.market.quote.v1",
    "apps/eqoboard-web/widgets/implementations/market/QuoteWidgets.tsx",
  ),
};

export const watchlistWidgetRegistration: WidgetRegistration<
  EmptyMarketConfigV1,
  Pick<NativeDataOperationMap, "market.quotes">,
  WidgetNoActionMap,
  MarketHostSnapshot
> = {
  manifest: watchlistManifest,
  Component: WatchlistWidget,
  allowedReadOperations: quoteOperations,
  allowedActions: noActions,
  parseConfig: parseEmptyMarketConfig,
  createDefaultConfig: () => EMPTY_MARKET_CONFIG,
  provenance: provenance(
    "eqoboard.native06.market.watchlist.v1",
    "apps/eqoboard-web/widgets/implementations/market/QuoteWidgets.tsx",
  ),
};

function optionRegistration(
  widgetManifest: WidgetManifestV1,
  component: WidgetRegistration<
    OptionExpiryConfigV1,
    Pick<NativeDataOperationMap, "market.quotes" | "market.options.chain">,
    WidgetNoActionMap,
    MarketHostSnapshot
  >["Component"],
  provenanceId: string,
): WidgetRegistration<
  OptionExpiryConfigV1,
  Pick<NativeDataOperationMap, "market.quotes" | "market.options.chain">,
  WidgetNoActionMap,
  MarketHostSnapshot
> {
  return {
    manifest: widgetManifest,
    Component: component,
    allowedReadOperations: optionOperations,
    allowedActions: noActions,
    parseConfig: parseOptionExpiryConfig,
    createDefaultConfig: createDefaultOptionExpiryConfig,
    provenance: provenance(
      provenanceId,
      "apps/eqoboard-web/widgets/implementations/options/OptionsWidgets.tsx",
    ),
  };
}

export const optionsChainWidgetRegistration = optionRegistration(
  optionsManifest,
  OptionsChainWidget,
  "eqoboard.native06.market.options-chain.v1",
);
export const ivSkewWidgetRegistration = optionRegistration(
  ivManifest,
  IvSkewWidget,
  "eqoboard.native06.market.iv-skew.v1",
);

export const optionTapeWidgetRegistration: WidgetRegistration<
  EmptyMarketConfigV1,
  WidgetOperationMap,
  WidgetNoActionMap,
  MarketHostSnapshot
> = {
  manifest: tapeManifest,
  Component: OptionTapeWidget,
  allowedReadOperations: noReads,
  allowedActions: noActions,
  parseConfig: parseEmptyMarketConfig,
  createDefaultConfig: () => EMPTY_MARKET_CONFIG,
  provenance: provenance(
    "eqoboard.native06.market.option-tape.v1",
    "apps/eqoboard-web/widgets/implementations/options/OptionsWidgets.tsx",
  ),
};

export const feedStatusWidgetRegistration: WidgetRegistration<
  EmptyMarketConfigV1,
  WidgetOperationMap,
  WidgetNoActionMap,
  MarketHostSnapshot
> = {
  manifest: feedManifest,
  Component: FeedStatusWidget,
  allowedReadOperations: noReads,
  allowedActions: noActions,
  parseConfig: parseEmptyMarketConfig,
  createDefaultConfig: () => EMPTY_MARKET_CONFIG,
  provenance: provenance(
    "eqoboard.native06.market.feed-status.v1",
    "apps/eqoboard-web/widgets/implementations/market/QuoteWidgets.tsx",
  ),
};

export const orderbookWidgetRegistration: WidgetRegistration<
  EmptyMarketConfigV1,
  WidgetOperationMap,
  WidgetNoActionMap,
  MarketHostSnapshot
> = {
  manifest: orderbookManifest,
  Component: OrderbookWidget,
  allowedReadOperations: noReads,
  allowedActions: noActions,
  parseConfig: parseEmptyMarketConfig,
  createDefaultConfig: () => EMPTY_MARKET_CONFIG,
  provenance: provenance(
    "eqoboard.native06.market.orderbook.v1",
    "apps/eqoboard-web/widgets/implementations/market/QuoteWidgets.tsx",
  ),
};

export const verticalPreviewWidgetRegistration: WidgetRegistration<
  EmptyMarketConfigV1,
  WidgetOperationMap,
  Pick<NativeActionMap, "orders.preview.vertical">,
  MarketHostSnapshot
> = {
  manifest: previewManifest,
  Component: VerticalPreviewWidget,
  allowedReadOperations: noReads,
  allowedActions: previewActions,
  parseConfig: parseEmptyMarketConfig,
  createDefaultConfig: () => EMPTY_MARKET_CONFIG,
  provenance: provenance(
    "eqoboard.native06.market.vertical-preview.v1",
    "apps/eqoboard-web/widgets/implementations/market/VerticalPreviewWidget.tsx",
  ),
};

export const marketWidgetRegistrations: readonly AnyWidgetRegistration[] = Object.freeze([
  quoteWidgetRegistration,
  watchlistWidgetRegistration,
  optionsChainWidgetRegistration,
  ivSkewWidgetRegistration,
  optionTapeWidgetRegistration,
  feedStatusWidgetRegistration,
  orderbookWidgetRegistration,
  verticalPreviewWidgetRegistration,
]);
