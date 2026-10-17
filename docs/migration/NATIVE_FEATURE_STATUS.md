# Native implementation and acceptance status

## 2026-10-17 PR #67 / #68 补充

EqoBoard main 的 PR #67 添加了独立 `apps/desk` 本地行情台并扩展 Native 深色 UI/Stock Tape；PR #68 只优化 Desk 16:9 布局与自选列表交互（四个文件），**没有**改变 Native Web、OpenTerminal、Rust Gateway、MDP 或执行引擎的服务端与交易权限。Desk 直接使用 Futu/Alpaca/Yahoo，既有 Core Bars/MarketDataHost 来源治理与它隔离。Desk 的 IEX 历史与本机 Futu 分钟 bars 为混合展示，不能视为可信、完整、逐笔可重放的 MDP 数据集。旧 OpenTerminal 继续默认部署；Native 仍是目标主终端候选。完整九仓 owner 路由见 [platform-ops 九仓目标架构](https://github.com/lqepoch/platform-ops/blob/main/docs/NINE-REPOSITORY-ARCHITECTURE.md)。

## Source integration and local runtime follow-up, 2026-10-16

PR64 merged as `32bfc58124809bd3e37ac0069fd917e6be576e64` after exact-head
checks and self-review. Its final 326 unit/route and 27 browser tests passed;
earlier failed runs below remain historical evidence. This integrates source,
not a default production cutover or complete migration acceptance. PR65 adds
an Actions-built Windows local evaluation package and controlled local identity.
See [LOCAL_RUNTIME_REVIEW.md](LOCAL_RUNTIME_REVIEW.md) for scope, architecture,
security boundaries, evidence locations, unresolved gates and rollback.

Current source correction: `charts/history.ts` rebuilds each head refresh from the
bounded cursor chain and latest head. The accumulated-head capacity gap described
in the frozen observation below is historical, not a current source finding.
This does not establish a browser memory/performance budget or paired legacy/native results.

The option chain now keeps missing stream event time `unknown` and displays Gateway
receive time in a separate column. Option Tape explicitly observes contracts already
leased by other active widgets; it does not subscribe independently or imply complete
market coverage. New unit and standalone-Tape browser regressions require exact-head
Actions validation; they do not prove OPRA permission or actual trade coverage.

## PR #64 review, 2026-10-16

The previously reviewed head is `c0e22628249b8b2e946c13d7d28ed0c949ad9702`.
Its [Native Actions 38729250483](https://github.com/lqepoch/EqoBoard/actions/runs/38729250483)
completed successfully, including production app/image builds, 310 unit/route
tests, and **26 browser tests passed, zero failed/skipped/flaky**. The downloaded
Playwright JSON confirms those browser counts. All reported legacy, OpenBB and
CodeQL checks also completed successfully on that head; earlier pending/failed
statements below are historical observations, not its current check state.

This does **not** establish full migration acceptance: the Gateway fixture serves
empty market responses and an empty SSE stream, so that browser run does not
prove nonempty quote/chain/tape rendering or a real Provider connection. The
downloaded `native-license-audit.json` still reports three runtime notice blockers.
The image receipt remains `NOT_RELEASE`; old/default production is retained.

Review fixes and their exact-head validation are tracked in
[PR64_REVIEW.md](PR64_REVIEW.md). Auth/Workspace/market/tape regression tests added
after the observed head require a new Actions run; the 26-test result cannot be
transferred to those changes. The new controlled tape scenario remains explicitly
synthetic, with source entitlement unknown and no broker/provider connection.

## Later evidence, 2026-10-15

The table below remains a frozen `2fcd4b0` observation. Later source adds the
dedicated terminal-only `eqoboard-research-ai-reader` role granting only
`research:ai`; market-reader does not grant it and Research mode filters it.
Production role assignment and Anthropic access remain unverified. The earlier
license-auditor race was repaired and subsequent CodeQL checks passed; its old
failure is retained below as historical evidence.

Candidate `e5ac22d7936335158ef2f48625928f410bed5b12` completed
[Native Actions 38721584166](https://github.com/lqepoch/EqoBoard/actions/runs/38721584166).
Source boundary, all 233 protected legacy files, types, lint, format, unit/route
contracts, dependency audits, Next production build and runtime image build
passed. Container browser acceptance was **17 PASS / 9 FAIL**. The source SBOM
guard then rejected tracked source drift before image inspection, immutable
Syft scanning or receipt generation. No image identity or license closure is
claimed for that run. The earlier `429c6d4` browser result remains **11 PASS /
15 FAIL**; neither candidate's passing results certify later edits.

Follow-up source repairs address Workspace response races, stale stream columns
after feed-epoch changes, hidden-widget cancellation, cross-tab logout ordering,
the supported Yahoo MAX start date, and actual labeled PNG export. Their tests
must pass on the resulting exact head. Paired legacy/native performance,
deployment rollback, real Provider paths and complete runtime notices remain
unqualified. Core history head-refresh retention also remains a known capacity
gap: the cursor page cap does not itself bound continuously accumulated bars.
The legacy default deployment stays in place and PR #64 remains Draft.

## Frozen observation

This records a source and Actions observation at candidate
`2fcd4b0cf4c8b053853e4dcdb3f96f71c27168d6`, compared with protected legacy source
`fea1e952add7a11e799d6f9f198ddcee47fd12b6`. It supplements the frozen legacy
[feature inventory](FEATURE_INVENTORY.md); it does not certify later heads.

[Native Actions run 38713651058](https://github.com/lqepoch/EqoBoard/actions/runs/38713651058)
passed unit/route, type, lint, formatting, vulnerability and license metadata/text
checks, but failed the helper source-boundary check. The CodeQL aggregate also
reported a high-severity file-read race in the license auditor. Production build,
image, browser and runtime SBOM lanes did not execute. Fixes require new exact-head
checks; prior results cannot be transferred. The dependency metadata audit reports
a separate runtime notice gate as BLOCKED, with three unresolved conditions.

The implementation column records source availability and known functional limits.
It must not be conflated with full behavioral parity or release acceptance.

## State labels for updating the inventory

The current single `NOT_STARTED` label conflates four different facts. Suggested row-level columns:

- `IMPLEMENTED`: native source/registration/route exists. This says nothing about full behavioral parity.
- `SYNTHETIC_VERIFIED`: identify the exact candidate CI lane and claim actually exercised with deterministic fixtures. A passing unit/route test is not browser parity. The current 2fcd unit/route lane passed; its browser/container lanes did not execute because the source-boundary job failed.
- `PROVIDER_VERIFIED`: trusted real provider response, entitlement/coverage, provenance/time and end-to-end native path proved. No native market/research provider reaches this level from the evidence inspected here.
- `RELEASE_ACCEPTED`: frozen-head required checks, security/runtime/browser, migration/rollback, paired performance, owner acceptance. None of the rows below meet this bar.

Use `PARTIAL` where source exists but legacy behavior is intentionally narrower or a critical permission/source boundary blocks use. Use `INERT/RETIRED` for TV and `DISABLED` for unsupported depth/execution. Avoid treating registry presence, a parser test, a source hash, or an authored E2E spec as parity proof.

## Legacy widgets: old path → native proposal and evidence

`legacy-contract-v1.ts` inventories 20 old kinds, maps 19 to static manifests, and explicitly keeps `tv` inert. `native-registry.test.ts` proves that accounting and that mappings resolve to registrations; it does not test each widget’s complete UI behavior. “Synthetic” below means applicable unit/route tests passed on 2fcd where present; the native E2E suite was skipped for that candidate.

| Legacy module | Native source, route and contract | Tests / specific evidence gap | IMPLEMENTED | SYNTHETIC_VERIFIED | PROVIDER_VERIFIED | RELEASE_ACCEPTED |
|---|---|---|---|---|---|---|
| `quote` — `apps/openterminal/web/components/widgets/QuoteWidget.tsx` | `widgets/implementations/market/QuoteWidgets.tsx` → `market.quote`; `market.quotes`; `/api/quotes`. | Market registry and market-contract tests exercise registration/decoder shapes. No quote UI interaction E2E or real SIP source/entitlement proof. | Partial | Contract only | No | No |
| `chart` — `.../widgets/ChartWidget.tsx` | `widgets/implementations/charts/ChartWidget.tsx`, manifest `eqoboard.chart`; Core Bars and separate diagnostic-archive operations. Research Yahoo chart is isolated at `/research/yfinance/{symbol}` and `/api/research/yfinance/daily`. | `ChartWidget.test.tsx`, chart config, Core/diagnostic contract tests; Research browser specs define synthetic Yahoo-only behavior. No current-head browser run and no SIP chart E2E/provider proof. | Partial | Unit/route only | No | No |
| `watchlist` — `.../widgets/WatchlistWidget.tsx` | `QuoteWidgets.tsx` → `market.watchlist`, workspace symbols + `market.quotes`. | Registry/market tests; no add/remove/reorder/select watchlist browser acceptance and no verified quote source. | Partial | Contract only | No | No |
| `news` — `.../widgets/NewsWidget.tsx` | `widgets/research/ResearchViews.tsx` → `eqoboard.research.news`, `research.news`, `/api/research/data/news`. | `ResearchViews.test.ts`, research envelope/provider/route tests use bounded fixtures/mocks. No news-widget E2E, live-source or provider-terms validation. | Partial | Adapter/route only | No | No |
| `heatmap` — `.../widgets/HeatmapWidget.tsx` | `ResearchViews.tsx` + `features/research/treemap.ts` → `eqoboard.research.heatmap`, `research.heatmap`. | `treemap.test.ts`, research envelope/provider tests. No direct heatmap UI E2E or live source/coverage evidence. | Partial | Layout/adapter only | No | No |
| `screener` — `.../widgets/ScreenerWidget.tsx` | `ResearchViews.tsx` → `eqoboard.research.screener`, `research.screener`. | Research view/input/envelope/provider tests cover validation and fixtures. No screener UI E2E or real TradingView metadata/SIP price pairing. | Partial | Adapter/route only | No | No |
| `crypto` — `.../widgets/CryptoWidget.tsx` | `ResearchViews.tsx` → `eqoboard.research.crypto` (plus separate global operation). | Research envelope/provider tests; no direct UI E2E, live CoinGecko/Binance evidence, rate/terms review. | Partial | Adapter/route only | No | No |
| `macro` — `.../widgets/MacroWidget.tsx` | `ResearchViews.tsx` → `eqoboard.research.macro`, `research.macro`. | Research view/data/provider tests use fixtures; no direct UI E2E or real FRED/ECB source/as-of validation. | Partial | Adapter/route only | No | No |
| `options` — `.../widgets/OptionsWidget.tsx` | `widgets/implementations/options/OptionsWidgets.tsx` → `market.options-chain`; `market.options.chain`, bounded lease and Core option contracts. | Market registry, option contract, stream and lease tests. No full expiry/grid/freshness E2E, OPRA entitlement/coverage or real options feed evidence. | Partial | Contract/lease only | No | No |
| `ivskew` — `.../widgets/IvSkewWidget.tsx` | `OptionsWidgets.tsx` → `market.iv-skew`; provider-returned per-contract IV/Greeks, no interpolation. | Same option registry/contract tests. No direct IV curve UI E2E or model/source timestamp validation. | Partial | Contract only | No | No |
| `optiontape` — `.../widgets/OptionTapeWidget.tsx` | `OptionsWidgets.tsx` → `market.option-tape`; consumes shared typed stream events. | Stream parser/lease tests and `live-stream-boundary.spec.ts` (auth/transport only). CI Gateway stream is deliberately empty; no tape rows, OPRA entitlement or native tape interaction is verified. | Partial | Transport/parser only | No | No |
| `vertical` — `.../widgets/VerticalSpreadWidget.tsx` | `VerticalPreviewWidget.tsx` → `market.vertical-preview`; closed `orders.preview.vertical` action at `/api/eqo/orders/preview`. Submit/execution is absent. | Market preview decoder/action tests; `execution-boundary.spec.ts` protects old Futu simulated execution, not new preview widget interaction. No native preview E2E/provider receipt. | Partial, preview-only | Contract/disabled boundary | No | No |
| `portfolio` — `.../widgets/PortfolioWidget.tsx` | `features/portfolio/PortfolioWidget.tsx`; `eqoboard.portfolio.manual-ledger`, owner-scoped `/api/portfolios/*` and SQLite storage. It is not broker account state. | Registration/storage tests; OIDC browser spec source covers owner isolation/CRUD but did not run on 2fcd. No legacy local-row migration/cutover proof. | Partial, manual ledger | Storage/route contracts; browser NOT_RUN | N/A (no provider) | No |
| `ai` — `.../widgets/AiWidget.tsx` | `ResearchAiWidget.tsx` → `eqoboard.research.ai-assistant`, closed `research.ai` action at `/api/research/ai`, requiring `research:ai`. | Parser and route tests pass mocked authorization. `permissions.ts` grants no allowlisted role `research:ai`; auth UI projection also omits it, and acceptance doc line 141 explicitly calls out missing CI role. Thus the shipped source has no current role grant path. No provider/E2E proof. | Partial, unusable under current role map | Schema/mocked route only | No | No |
| `calendar` — `.../widgets/CalendarWidget.tsx` | Native economic calendar plus distinct `eqoboard.research.earnings-calendar` and `...earnings-history` views/operations. | Provider/input/route unit tests; no calendar widget E2E, no real schedule/actual-time coverage validation. | Partial | Adapter/route only | No | No |
| `insider` — `.../widgets/InsiderWidget.tsx` | `ResearchViews.tsx` → `eqoboard.research.insider`, SEC submissions/Form 4 adapter. | Research provider and input tests use deterministic payloads; no insider UI E2E or live SEC completeness/provenance qualification. | Partial | Adapter/route only | No | No |
| `tv` — `.../widgets/TvWidget.tsx` | No native renderer or route. `LEGACY_WIDGETS_RETAINED_INERT = ["tv"]`; unknown/retired import tile remains inert. | `native-registry.test.ts` asserts inert mapping. This is an explicit omission due unverified third-party stream/embed rights, not an unfinished video implementation. | No; intentional inert | Inert behavior only | No | No |
| `recap` — `.../widgets/RecapWidget.tsx` | `widgets/research/RecapWidget.tsx` → `eqoboard.research.recap`, `research.recap`; requires both research and market-read permissions before provider work. | Recap server/data/operation tests cover bounded mixed-source evidence; no direct recap widget E2E or synchronized/real multi-provider proof. | Partial | Adapter/route only | No | No |
| `researchpredictions` — `.../widgets/ResearchPredictionsWidget.tsx` | `RegisteredPredictionsWidget.tsx` → `eqoboard.research.registered-predictions`, fixed `/api/eqo/research/predictions/{runId}`, `research:private-read`. | Prediction parser and route denial tests; OIDC E2E source asserts reader denial but lacks authorized success on exact current head. Quant artifact/provider is not verified. | Partial, read-only | Parser/denial only | No | No |
| `enginepreview` — `.../widgets/EngineOfflinePreviewWidget.tsx` | `EngineOfflinePreviewWidget.tsx` → `eqoboard.research.engine-offline-preview`, fixed `/api/eqo/engine/status` and `/preview`, `engine:offline-read`. | Synthetic parser tests reject connected/executable claims; OIDC E2E covers wrong-role denial, not successful engine-reader path. Source remains unknown and reads are not a snapshot. | Partial, diagnostic-only | Synthetic parser/denial only | N/A for market provider; Engine runtime not verified | No |

## Old Pro panels: paths and concrete gaps

| Legacy Pro path | Current native counterpart | Evidence/remaining parity |
|---|---|---|
| Header, symbol and account summary — `components/terminal/TerminalHeader.tsx` | `TerminalShell.tsx`, navigation/command palette, `AccountControl.tsx`; symbol search is metadata-only. | Shell, keyboard navigation, synthetic symbol-search tests/specs exist. No exact account-summary parity; legacy seeded account value is intentionally excluded. Current browser lane skipped. |
| Watchlist — `components/terminal/WatchlistPanel.tsx` | Workspace `market.watchlist` / `QuoteWidgets.tsx`. | Does not establish Pro `ALL/MAG7/TECH/ETF/SEMI` filters and mini-sparklines; no direct panel E2E. |
| Main chart and studies — `components/terminal/MainChartPanel.tsx` | `eqoboard.chart` and `ChartWidget.tsx`. | Core/diagnostic histories are separate and typed; no Pro panel interaction/study parity E2E or live SIP history proof. |
| Order book and tape — `components/terminal/OrderBookPanel.tsx` | `market.orderbook` is registered but explicitly inert/unavailable; `market.option-tape` is a separate typed stream widget. | `market-source-boundary.spec.ts` asserts unsupported depth/no dispatch; stream spec has no events. No Level-2/tape rows, selected-price wiring, or verified provider source. |
| Paper ticket, positions and orders — `components/terminal/PaperTradingPanel.tsx` | Offline vertical preview plus separate manual portfolio. | No buy/sell/submit, seeded account, positions-as-broker state, order history or execution. `execution-boundary.spec.ts` only rejects legacy fake Futu execution. No Paper/Live permission or provider proof. |
| Feed/status bar — `components/terminal/TerminalStatusBar.tsx` | `market.feed-status` / `FeedStatusWidget` from shared market host. | UI can represent transport/freshness/lease/unknown fields, but empty CI stream cannot prove feed/entitlement freshness; no Pro status-bar E2E. |

## Additional native-only capabilities and state

- Native research-only: saved queries (`SavedQueriesWidget`, `query-config.test.ts`), symbol search (closed `research.symbolSearch`; keyboard flow has a synthetic browser spec), Yahoo daily history (separate Research origin and MDP route), economic/earnings calendars, earnings history, recap, AI, private predictions and Engine diagnostics. These are not exact replacements for legacy market widgets. All provider-route unit tests use fixtures/mocks; Research E2E was skipped on the exact current head.
- Legacy workspace import/export/recovery and owner-scoped persistence have meaningful native source, migration tests, and OIDC E2E definitions (`workspace-migration`, `workspace-layout-export`, `workspace-recovery`, `oidc-workspace-isolation`). The production browser lane was skipped on 2fcd, so treat these as `IMPLEMENTED` with applicable unit/route assertions in the passing lane and `browser NOT_RUN`; this is not browser parity for this head.
- OpenBB Workspace remains isolated in Rust Gateway compatibility APIs. The capability matrix itself says native React registry, permissions and Workspace document are different contracts. OpenBB catalog presence is not native feature or data-provider proof.

## Cross-cutting blockers before parity or release claims

1. **Missing AI policy grant:** `widgets/research/registrations.tsx` and `/api/research/ai` require `research:ai`, but `lib/server/permissions.ts` allowlisted roles omit it and `lib/server/auth.ts` omits it from the Research UI projection. The only route tests stub authorization; acceptance doc already records the missing role. Decide the intended least-privilege issuer role before calling AI implemented for users.
2. **Current head gate is failed:** helper boundary test and CodeQL fail, with required/pending checks; image/browser/runtime SBOM lanes did not run. Repair the false-positive rule or helper representation without removing the denial assertions, then require a new run bound to the resulting exact head.
3. **No market provider qualification:** CI Gateway fixture has no quotes, bars, options/depth/tape, order-submit or provider connector. The MDP fixture is synthetic Yahoo daily only. No current Native Actions evidence proves SIP/OPRA/Futu entitlement, provider generation, feed freshness, coverage, or source quality.
4. **No production authorization/deployment proof:** no production issuer/ingress/session deployment, owner-scoped data migration, verified backup/restore, rollback exercise, or user sign-off. Existing legacy OpenTerminal remains production entrypoint per acceptance contract.
5. **Performance and capacity not qualified:** request limits are process-local and un-load-tested; same-runner legacy-vs-native paired performance is `NOT_RUN`; native candidate timings from synthetic Yahoo are not provider or production capacity evidence.
6. **Dependency/runtime notices:** source/dependency metadata lane passed on 2fcd, but runtime image lane skipped. Earlier ffdbe reported three runtime notices blocked. Do not state final image/license acceptance until image/SBOM/runtime notice lanes complete on a passing frozen head.

