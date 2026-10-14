# OpenTerminal chart history routing

The main trading chart and the Workspace Chart widget use the same browser history client and the same origin route, `/api/history/{symbol}`. The browser sends the selected range, requested resolution, caller-selected provider mode, caller-declared asset class, `session_scope=all`, `adjustment=unadjusted`, and `allow_daily_downgrade=true`. Provider mode is one of `auto`, `alpaca_only`, or `futu_only`; it is a read preference and does not assert which provider returned the bars. `asset_class` is a caller declaration (`stock` or `etf`), not a security-master classification.

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
