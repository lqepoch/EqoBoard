# OpenTerminal chart history routing

This document's opt-in flag and legacy fallback describe the retained OpenTerminal application.
Native `apps/eqoboard-web` uses Core Bars by default and requires MDP; missing MDP returns
unavailable, without a legacy fallback. Its controlled Windows profile is documented in
`NATIVE_LOCAL_START.md`; Linux app-only requires an external MDP origin. Native local MDP access
requires the explicit `EQO_LOCAL_CORE_BARS` opt-in and isolated terminal key on exact loopback 8088.

The main trading chart and the Workspace Chart widget use the same browser history client and the same origin route, `/api/history/{symbol}`. The browser sends the selected range, requested resolution, caller-selected provider mode, caller-declared asset class, `session_scope=all`, `adjustment=unadjusted`, and `allow_daily_downgrade=true`. Provider mode is one of `auto`, `alpaca_only`, or `futu_only`; it is a read preference and does not assert which provider returned the bars. `asset_class` is a caller declaration (`stock` or `etf`), not a security-master classification.

The interval control defaults to `Auto`, which follows these range-to-resolution defaults. Choosing a supported interval overrides the range default without changing the selected date range. Supported explicit intervals are `1m`, `5m`, `15m`, `1h`, and `1D` (sent as `1d`). Legacy controls that have no market-bars resolution remain visible but disabled with an explanation; they never fall back to another interval. `Auto` avoids pinning `1D` to `1m` when the user later selects `MAX`.

Range-to-resolution defaults are:

| Range | Requested resolution |
| --- | --- |
| `1D` | `1m` |
| `5D` | `5m` |
| `1M` | `1h` |
| `6M`, `YTD`, `1Y`, `5Y`, `MAX` | `1d` |

The first request omits `request_start`, `request_end`, and `cursor`; the BFF resolves a bounded half-open UTC window and returns its exact boundaries. Older-page requests echo those boundary strings unchanged and pass the opaque continuation cursor. The browser does not decode or synthesize cursors. Page merges deduplicate on effective resolution and bar timestamp. When pages overlap, the newer page retains the timestamp's value. Loading older pages preserves the chart's visible logical range; refreshes at the right edge retain the visible bar count and continue following the latest bar. Only symbol, selected range, or requested resolution changes reset the viewport; changing provider mode keeps its zoom and visible range.

Automatic refresh uses a separate latest-page query so it never refetches the loaded cursor chain: the `1D` range refreshes every 8 seconds and other ranges every 60 seconds while the page is visible. Older pages keep the original response window and cursor. The chart retains at most 20 pages total, including the refreshed head; if another cursor remains at that limit, it stops loading older pages and reports that the `MAX` history is incomplete instead of evicting the newest page.

The in-memory query key includes a random browser-page cache scope plus symbol, range, requested resolution, provider mode, session scope, adjustment, and caller-declared asset class. The page scope is local to the browser cache and is never sent to the BFF.

The BFF's requested/effective resolution and downgrade reason are shown as returned. If the upstream route downgrades an intraday request that crosses the supported intraday boundary, the whole response must use daily bars and state the effective resolution; the client does not infer a downgrade from the selected range or calendar. Exchange calendar claims come only from explicit upstream metadata.

Bars are plotted only after bounded finite numeric projection checks. When the BFF returns `exact` decimal strings, the chart preserves those strings in the OHLCV hover values and uses their validated numeric projection for Lightweight Charts. The chart never turns a quote snapshot into a bar and never lets quote updates replace historical rows. Source, provider, feed, delay, verification, coverage, gaps, segments, as-of time, and asset-class declaration are displayed from response metadata; absent values stay `unknown`.

The MDP diagnostic archive remains a separate, opt-in Workspace view. It is explicitly diagnostic/NOT LIVE and is not substituted for provider history when the provider route is unavailable.

The MDP-backed chart E2E cases in `web/e2e/market-data-chart-history.spec.ts` run with `E2E_MDP_MARKET_BARS_ENABLED=true` in the dedicated enabled-mode CI step. In the default-off suite, this spec reports an explicit skip because its fixture-provider assertions require the enabled BFF route; the default-off compatibility check and existing legacy chart E2E cases continue to run.

The enabled chart suite includes a bounded synthetic `MAX` response with separate daily segments on 2015-12-31 and 2016-01-04, labeled with Yahoo/yfinance and Alpaca provenance. These fixture starts use 05:00Z, midnight in New York during these winter dates; the fixture matches the widget's caller-declared `stock` request and the test checks that BFF request identity before switching to `MAX`. It includes a duplicate timestamp at the same daily resolution and verifies that both provenance identities and each half-open UTC segment interval remain inspectable while the chart plots one candle per effective-resolution timestamp. BFF timestamp serialization may omit zero fractional seconds, so the test compares parsed UTC instants. The source labels explicitly say `synthetic fixture; unverified`; this checks projection and UI behavior only, not Yahoo adjustment semantics, Alpaca entitlement, or real provider coverage across 2016.

The suite also requests `MAX` at an explicit `15m` resolution with `allow_daily_downgrade=true` and verifies the BFF response and UI keep `requested=15m`, `effective=1d`, daily-only rows, and `downgrade=unknown`. Core Bars V1 currently supplies no specific downgrade-cause field, so the UI preserves that unknown instead of inferring a provider or calendar reason. This fixture verifies the authorized downgrade presentation and no mixed-granularity plotting; it does not establish the real upstream cutoff policy or cause.

The isolated Yahoo chart is daily-only, including when the range selector says `1D` or `5D`. Those two views request a bounded 7- or 14-calendar-day lookup window and plot up to the latest one or five returned daily observations; unavailable sessions remain absent rather than being filled. `1M`, `6M`, `1Y`, and `5Y` use rolling UTC calendar month/year subtraction with the day clamped to the target month's last day (for example, 2024-03-31 minus one month is 2024-02-29). `YTD` starts at January 1 UTC, and `MAX` retains its fixed 1970 lower bound and bounded newest-first cursor pages. The widget shows the exact half-open UTC request window and identifies the short views as daily observations, not intraday bars. A fixed-clock browser E2E checks month-end/leap-day boundaries, a weekend end, the visible one/five-bar projection, and that displayed timestamps are returned weekday observations. The dates and bars in that test are synthetic; it proves request and projection behavior, not the exchange calendar or Yahoo history.

The MainChartPanel keeps its interval toolbar, drawing-tool selection state, indicator controls, chart-type controls, and four-card Intelligence Dashboard. Its Day Range card is populated only by a same-symbol quote explicitly marked real; RSI uses the shared bar-history calculation. 52-week and Quant Research cards remain unavailable without qualified coverage/signal metadata. These cards do not synthesize values from a quote or create bars from a quote snapshot.
