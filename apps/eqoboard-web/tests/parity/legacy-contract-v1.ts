/**
 * Source inventory only. This fixture does not import or execute legacy code.
 * Rebind sourceSha to the final post-PR59 baseline before production cutover.
 */
export const LEGACY_SOURCE_BASELINE = Object.freeze({
  sourceSha: "fea1e952add7a11e799d6f9f198ddcee47fd12b6",
  inventoryStatus: "audited; final cutover baseline must be re-frozen",
  widgetSource: "apps/openterminal/web/store/terminal.ts",
  workspaceSource: "apps/openterminal/web/components/Workspace.tsx",
  proRootSource: "apps/openterminal/web/components/terminal/ModernTerminal.tsx",
});

export const LEGACY_WIDGET_TYPES = [
  "quote",
  "chart",
  "watchlist",
  "news",
  "heatmap",
  "screener",
  "crypto",
  "macro",
  "options",
  "ivskew",
  "optiontape",
  "vertical",
  "portfolio",
  "ai",
  "calendar",
  "insider",
  "tv",
  "recap",
  "researchpredictions",
  "enginepreview",
] as const;

export const LEGACY_DEFAULT_WIDGETS = [
  "chart",
  "options",
  "quote",
  "watchlist",
  "ivskew",
  "optiontape",
  "vertical",
  "news",
  "macro",
] as const;

/**
 * Reviewed V1 mapping from the frozen legacy capability names to statically
 * compiled native manifests. Keeping this explicit prevents registry growth or
 * a structurally valid unknown manifest from silently becoming parity.
 */
export const LEGACY_NATIVE_WIDGET_BINDINGS = [
  { legacyType: "quote", manifestId: "market.quote" },
  { legacyType: "chart", manifestId: "eqoboard.chart" },
  { legacyType: "watchlist", manifestId: "market.watchlist" },
  { legacyType: "news", manifestId: "eqoboard.research.news" },
  { legacyType: "heatmap", manifestId: "eqoboard.research.heatmap" },
  { legacyType: "screener", manifestId: "eqoboard.research.screener" },
  { legacyType: "crypto", manifestId: "eqoboard.research.crypto" },
  { legacyType: "macro", manifestId: "eqoboard.research.macro" },
  { legacyType: "options", manifestId: "market.options-chain" },
  { legacyType: "ivskew", manifestId: "market.iv-skew" },
  { legacyType: "optiontape", manifestId: "market.option-tape" },
  { legacyType: "vertical", manifestId: "market.vertical-preview" },
  { legacyType: "portfolio", manifestId: "eqoboard.portfolio.manual-ledger" },
  { legacyType: "ai", manifestId: "eqoboard.research.ai-assistant" },
  { legacyType: "calendar", manifestId: "eqoboard.research.economic-calendar" },
  { legacyType: "insider", manifestId: "eqoboard.research.insider" },
  { legacyType: "recap", manifestId: "eqoboard.research.recap" },
  { legacyType: "researchpredictions", manifestId: "eqoboard.research.registered-predictions" },
  { legacyType: "enginepreview", manifestId: "eqoboard.research.engine-offline-preview" },
] as const;

/** Explicit V1 gaps; these kinds stay inert rather than resolving arbitrary code. */
export const LEGACY_WIDGETS_RETAINED_INERT = [
  "tv",
] as const;

export const LEGACY_PRO_PANELS = [
  {
    id: "header-symbol-account-summary",
    source: "apps/openterminal/web/components/terminal/TerminalHeader.tsx",
    acceptance: "preserve-symbol-intent; seeded-account-value-is-not-real",
  },
  {
    id: "watchlist",
    source: "apps/openterminal/web/components/terminal/WatchlistPanel.tsx",
    acceptance: "preserve-user-symbols; hard-coded-quotes-are-not-market-evidence",
  },
  {
    id: "main-chart-and-studies",
    source: "apps/openterminal/web/components/terminal/MainChartPanel.tsx",
    acceptance: "typed-history-only; source-gaps-time-and-attribution-preserved",
  },
  {
    id: "order-book-and-tape",
    source: "apps/openterminal/web/components/terminal/OrderBookPanel.tsx",
    acceptance: "unsupported-until-typed-entitled-source; no-simulated-rows",
  },
  {
    id: "paper-ticket-and-positions-orders",
    source: "apps/openterminal/web/components/terminal/PaperTradingPanel.tsx",
    acceptance: "preview-only; no-account-order-history-or-execution-claim",
  },
  {
    id: "feed-status-bar",
    source: "apps/openterminal/web/components/terminal/TerminalStatusBar.tsx",
    acceptance: "measured-source-or-unknown; no-invented-quota-or-connection",
  },
] as const;

export const LEGACY_SIMULATED_EXECUTION_MARKERS = [
  "PAPER_READY",
  "FILLED",
  "simulator-fallback",
] as const;
