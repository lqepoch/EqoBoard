# Native migration feature inventory

This inventory records behavior present in frozen legacy source snapshot
fea1e952add7a11e799d6f9f198ddcee47fd12b6. It is a migration checklist, not a
claim that the native application has delivered these features. Its NOT_STARTED
column records the original inventory baseline, not current implementation progress.
Current source, synthetic-test, Provider and release states are reported separately
in [NATIVE_FEATURE_STATUS.md](NATIVE_FEATURE_STATUS.md). Source availability alone
does not establish parity, security, accessibility or release acceptance.

Native features are proposed for standalone apps/eqoboard-web. Exact registry
and data-operation names remain subject to root-frozen interfaces. Native code
must use pinned trading-core contracts, the single market host/coordinator and
the native BFF. Legacy routes below document old behavior only; native widgets
must not import or call the OpenTerminal BFF. Source identity, entitlement and
timestamps remain unknown unless the provider contract supplies trusted proof.

| Legacy module and source | Existing behavior and legacy route | Native proposal and contract | Existing tests and gap | Data source and permission | Status |
|---|---|---|---|---|---|
| Quote — apps/openterminal/web/components/widgets/QuoteWidget.tsx | GET /api/quotes?symbols=...; GET /api/short-volume/:symbol; linked symbol, feed freshness and FINRA short-volume supplement. | Workspace quote; pinned Core quote and supplemental short-volume contracts. | access-boundary.spec.ts, market-freshness.spec.ts; no dedicated quote interaction test. | SIP source/entitlement needs trusted metadata; short-volume is supplemental. market:read. | NOT_STARTED |
| Chart — .../widgets/ChartWidget.tsx | GET /api/history/:symbol; GET /api/eqo/market-data/datasets/:datasetId/bars?namespace=diagnostic&symbol=...; PR59 adds GET /api/research/yfinance/daily. Range, chart type, indicators, asset class, provider mode, adjustment, dataset ID and older-page controls. | Workspace chart; Core Bars and explicit provider class; diagnostic and research histories stay separate. | market-data-chart.spec.ts, market-data-chart-history.spec.ts, market-bars-bff.spec.ts, research-bff.spec.ts; no native parity. | SIP history, diagnostic dataset bars and Yahoo research differ. Yahoo is noncanonical, non-PIT, display-only; raw source/observation unconfirmed. market:read; research route also research:read. | NOT_STARTED |
| Watchlist — .../widgets/WatchlistWidget.tsx | GET /api/quotes?symbols=...; local add/remove/select and shared market stream. | Workspace watchlist; Core quote/stream and separately approved owner-scoped persistence. | Freshness/stream suites; no direct add/remove/reorder/select acceptance. | Provider and entitlement determine quote source. market:read; stream/subscribe when required. | NOT_STARTED |
| News — .../widgets/NewsWidget.tsx | GET /api/news or /api/news?symbol=...; all/symbol mode. | Workspace news research; source and observation-time contract. | No direct widget E2E. | Yahoo and Google RSS. research:read. | NOT_STARTED |
| Heatmap — .../widgets/HeatmapWidget.tsx | GET /api/heatmap?market=us|eu; market selection, refresh, resize and symbol click-through. | Workspace heatmap; Core market-row envelope with source, coverage and truncation. | market-http.test.ts, generic access checks; no direct widget E2E. | US SIP price support, TradingView metadata and EU research provider are distinct. market:read. | NOT_STARTED |
| Screener — .../widgets/ScreenerWidget.tsx | GET /api/sectors?market=..., GET /api/screener?...; filters, sort/direction, symbol selection. | Workspace screener; Core market-row contract. | market-http.test.ts; no direct widget E2E. | SIP prices and TradingView metadata/provider fields remain distinct. market:read. | NOT_STARTED |
| Crypto — .../widgets/CryptoWidget.tsx | GET /api/crypto, GET /api/crypto/global; select row/symbol. | Workspace crypto research; explicit provider/time contract. | No direct widget E2E. | Binance/CoinGecko, separate from SIP. research:read. | NOT_STARTED |
| Macro — .../widgets/MacroWidget.tsx | GET /api/macro?region=us|eu; region and index selection. | Workspace macro; typed observation/source/as-of contract. | Provider/server unit tests; no direct widget E2E. | FRED, ECB and index sources are distinct. Existing route maps to market:read; review least privilege. | NOT_STARTED |
| Options — .../widgets/OptionsWidget.tsx | GET /api/options/:symbol?expiry=...; POST /api/eqo/options/subscribe; expiry/contract selection, spread legs and batched AG Grid Community transactions. | Workspace OPRA chain; pinned Core option quote/trade types and bounded subscription lease. | market-stream.spec.ts, market-http.test.ts, Community grid source checks; no complete native grid/expiry/selection/freshness suite. | OPRA coverage/entitlement unknown without trusted metadata; modeled Greeks are not OPRA observations. market:read, market:subscribe and stream. | NOT_STARTED |
| IV Skew — .../widgets/IvSkewWidget.tsx | GET /api/options/:symbol?expiry=...; expiry and curve. | Workspace volatility; Core option snapshot and calculation provenance. | Option API tests; no direct UI E2E. | Chain source and modeled IV/Greeks independently labeled. market:read. | NOT_STARTED |
| Option Tape — .../widgets/OptionTapeWidget.tsx | Reads optionTrades from shared market state for subscribed OCC contracts. | Workspace OPRA tape; Core ordered event/trade contract and bounded lease. | market-stream.spec.ts covers lease/events, not tape interaction. | Raw source, sequence, freshness and entitlement required; no inferred aggressor side. market:stream, market:subscribe. | NOT_STARTED |
| Vertical Spread — .../widgets/VerticalSpreadWidget.tsx | Reads status; previews/submits through legacy order routes; leg edits invalidate preview fingerprint/generation and outcome. | Offline preview only; Core order-intent/preview/outcome contracts. | market-order.spec.ts, access-boundary.spec.ts, order-contract.test.ts establish disabled boundary, not native parity. | Effective execution disabled; writes blocked; Paper/Live not enabled. | NOT_STARTED |
| Portfolio — .../widgets/PortfolioWidget.tsx | Reads portfolios, positions, transactions and quotes; adds/deletes transactions. | Workspace portfolio; separately approved owner-scoped persistence and Core quote marks. | portfolio.test.ts; no browser ownership/session/data-lifecycle acceptance. | Legacy server ownership is verified issuer+subject. Never auto-assign old local rows. workspace:read/write. | NOT_STARTED |
| AI Assistant — .../widgets/AiWidget.tsx | Reads quote context and posts prompts to /api/ai/chat; prompt/history state. | Separately permissioned research assistant with provider disclosure. | No direct widget E2E. | Optional Anthropic only; no synthetic substitute. Inspected current OIDC role map appears not to grant research:ai; resolve before enabling. | NOT_STARTED |
| Calendar — .../widgets/CalendarWidget.tsx | Reads /api/econ-calendar, /api/calendar?symbols=..., /api/earnings-history/:symbol; impact/timezone/tab/expanded state. | Workspace calendar; typed event, earnings and observation-time contracts. | Market HTTP route tests; no direct UI E2E. | Forex Factory, FRED, TradingView, Nasdaq and SIP are distinct. research:read for calendar, market:read for earnings history. | NOT_STARTED |
| Insider — .../widgets/InsiderWidget.tsx | Reads GET /api/insider/:symbol; symbol-linked SEC Form 4 entries. | Workspace insider research; preserve filing date versus transaction observation date. | No direct widget E2E. | SEC filings. research:read. | NOT_STARTED |
| Live TV — .../widgets/TvWidget.tsx | Plays direct HLS URLs through hls.js; five channel selectors; no Eqo BFF. | Candidate media feature only after rights, authenticity and availability review; otherwise document omission. | No E2E. | MIT source license does not grant remote stream/content rights; provider and availability unverified. No Eqo permission boundary. | NOT_STARTED |
| Recap — .../widgets/RecapWidget.tsx | Reads /api/recap; index/gainer/loser clicks change active symbol. | Workspace recap; Core prices plus separate macro/news contracts. | Server/API tests; no direct widget E2E. | SIP prices, FRED VIX and news need separate source/time metadata. market:read. | NOT_STARTED |
| Registered Prediction — .../widgets/ResearchPredictionsWidget.tsx | Reads /api/eqo/research/predictions/:runId; selects run and parses bounded envelope. | Private research; pinned Core PredictionEnvelope parser stays server-side. | research-prediction.spec.ts; no native auth/parity. | eqoboard-private-research-reader; research:private-read. | NOT_STARTED |
| Engine Offline Preview — .../widgets/EngineOfflinePreviewWidget.tsx | Reads Engine status and preview; refresh/abort. | Read-only diagnostics; pinned Core Engine status and synthetic preview parsers. | engine-offline-preview.spec.ts; no native auth/parity. | Dedicated eqoboard-engine-offline-reader; engine:offline-read. Synthetic best-effort diagnostic, source unknown, not transaction authority. | NOT_STARTED |

## Additional legacy surface

MarketFeedStatus.tsx is a nonregistered helper embedded in quote, watchlist,
options and tape. It reports SSE acknowledgement, lease, coverage, auth and
source state. OrderOutcomePanel.tsx is a Vertical Spread helper.

Workspace registration is split between store/terminal.ts,
components/Workspace.tsx, components/Sidebar.tsx, title/default-layout and
hotkey tables. Add a native registry consistency test so a feature cannot be
listed but fail to render or lack default configuration.

Legacy persisted state uses Zustand key eqoboard-open-terminal-v1 for active
symbol, widgets, grid layout, watchlist, command state and option legs. It has
no explicit schema version/migration/validation/identity scoping. eqo_view_mode
separately stores the Pro/workspace choice. Anonymous legacy layout data may be
previewed or explicitly imported but never becomes owned automatically by the
first signed-in identity. Browser export excludes auth, market, account and
order data.

The separate Pro view is selected by ?view=pro; explicit local access defaults
to Pro unless eqo_view_mode=workspace is saved.

| Pro panel | Behavior and interaction | Existing boundary and test gap | Status |
|---|---|---|---|
| TerminalHeader | Search, popular-symbol buttons, four tabs, Workspace switch; some quote/change values are hardcoded. | Separate trading store; hardcoded values are not market evidence. No dedicated E2E. | NOT_STARTED |
| WatchlistPanel | ALL/MAG7/TECH/ETF/SEMI filters, search, selection and mini-sparklines. | Separate store calls /api/futu/quotes; synthetic fallback possible. No dedicated E2E. | NOT_STARTED |
| MainChartPanel | Chart range/interval controls and history. | Shared history client; market-data-chart-history.spec.ts only. | NOT_STARTED |
| OrderBookPanel | Level 2 / Time & Sales tabs; selected price populates paper ticket. | Polls /api/futu/orderbook and /api/futu/trades. No dedicated E2E. | NOT_STARTED |
| PaperTradingPanel | Buy/sell, market/limit, quantity, percentage sizing, positions/history. | Uses /api/futu/order and /api/futu/account, not guarded /api/eqo/orders. No dedicated E2E. | NOT_STARTED |
| TerminalStatusBar | Clock and connection/cache/latency status. | Separate store polls Futu endpoints about once per second. No dedicated E2E. | NOT_STARTED |

The legacy Futu catch-all route has an unresolved safety conflict: when Futu is
unavailable it reports simulator fallback, yet status includes hardcoded
PAPER_READY; account reads return preset in-memory positions and a filled
order; order POST mutates memory and returns FILLED without broker contact.
Ordinary OIDC middleware does not authenticate this route. Native must not reuse
or relabel it as real market data or Paper/Live capability. Keep effective
execution disabled. Product disposition is exclusion or a clearly disabled
explanatory view.

## Acceptance evidence boundary

Existing browser suites cover access boundaries, market freshness/stream/order,
chart/history, market-bars BFF, research BFF/navigation, private predictions
and Engine offline preview. Direct UI coverage is absent or incomplete for AI,
calendar, crypto, heatmap, insider, IV skew, macro, news, portfolio, recap,
screener, TV, option tape, many quote/watchlist actions and every Pro panel
except chart history. Existing suites are legacy baseline evidence, not native
parity.

tools/upstream_diff.py compares vendored OpenTerminal files to pinned upstream
and classifies exact/modified/EqoBoard-only/deleted paths. Its tests do not
hash-pin the complete EqoBoard-only/modified application or detect all legacy
path deletions. tests/test_upstream_provenance.py checks a 40-character commit,
MIT identifier/text and selected package facts; it does not pin the exact
OpenTerminal commit/archive hash or prove feature parity. The new
tools/migration/legacy-integrity.mjs and immutable manifest protect source bytes
only. Hash integrity is not feature parity, security qualification, deployment
approval or release acceptance.

The baseline statuses above remain preserved for comparison. Current implementation
and acceptance states must identify native route/UI/state behavior, source/permission
results, meaningful tests and exact candidate evidence in NATIVE_FEATURE_STATUS.md.
Preserve missing/unverified provider data as unavailable;
do not substitute synthetic quotes, tape, bars, depth, accounts or orders.
