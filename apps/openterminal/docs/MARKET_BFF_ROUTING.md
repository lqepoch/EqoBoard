# OpenTerminal Market History BFF

The same-origin `GET /api/history/{symbol}` route is the browser boundary for historical OHLCV. `EQO_MDP_MARKET_BARS_ENABLED` is an explicit server-side rollout switch and defaults to `false`. With the switch off, `provider_mode=auto` retains the existing Gateway/Express routing and response. An explicit provider choice returns `501 provider_selector_unavailable`; it never changes a source label to imply that a provider choice was applied.

When enabled, the BFF sends a bounded read request to the configured `EQO_MDP_URL` at `/v1/market/bars`. It first parses the wire with the pinned Core `BarsResponseV1Schema`, then checks request identity, UTC nanosecond timestamps, provenance links, decimal OHLCV, permitted resolution downgrade, adjustment, cursor consistency, and finite numeric projection before it returns data. Invalid or unavailable MDP responses fail closed; the BFF does not retry through Gateway, Express, or a research provider.

## Request and window

`range` is required while the MDP route is enabled and accepts `1D`, `5D`, `1M`, `6M`, `YTD`, `1Y`, `5Y`, or `MAX`. The BFF maps that range to a coarse UTC half-open window and returns its exact `request_start` and `request_end` values. The market-data service supplies the trusted market-calendar version. Resolution defaults are `1D → 1m`, `5D → 5m`, `1M → 1h`, and longer ranges to `1d`; a caller may request `1m`, `5m`, `15m`, `1h`, or `1d` explicitly.

The remaining supported query fields are `asset_class=stock|etf`, `session_scope=all|regular|extended|overnight`, `adjustment=unadjusted|split|dividend|all`, `provider_mode=auto|alpaca_only|futu_only|research`, and `allow_daily_downgrade=true|false`. Asset class is caller-declared for this route; it is not represented as independent security-master verification. The browser cannot control the upstream row limit; the BFF always requests at most 1,000 rows. Unknown, repeated, malformed, and unsupported query fields are rejected before any upstream request.

The first page omits `cursor` and boundaries. A continuation request includes the opaque `next_cursor` plus the exact `request_start` and `request_end` returned by the first page. The BFF validates the UTC pair and bounded range, preserves all other normalized query fields, and passes the cursor through unchanged. It does not decode or synthesize cursor contents. The MDP cursor is responsible for binding the continuation to the original normalized query.

## Response and source facts

The response preserves the Core V1 snake-case envelope, including rows, coverage, segments, gaps, source provenance, provider/feed, entitlement, timestamps, cache state, calendar version, cursor, and truncation. It also includes `request_start` and `request_end`, and projects legacy chart-compatible `bars` entries with Unix-second `time`, finite numeric OHLCV, `asOf`, and `bars[].exact` decimal strings. Decimal strings remain authoritative for precision; the numeric values are a bounded display projection only. An upstream `feed=unknown` remains `unknown`; the BFF accepts it only as a source fact, not as proof of a named feed.

The compatibility fields `source`, `source_mode`, and `source_label` reflect returned provider/provenance facts. `asset_class_source` is `caller_declared`. `verification` remains `unknown`: structural row validation, a Core `validated` row state, or a `verified_at` timestamp alone does not prove Alpaca source identity, entitlement, or cache acceptance. If a resolution downgrade is reported without a reason from the upstream contract, `downgrade_reason` is `unknown`. Unknown delays remain `null`.

U.S. equity/ETF symbols use the shared symbol router for basic route eligibility; explicitly known crypto and index symbols are rejected with `422`. This route does not infer instrument type from the browser's label or apply stock history cutoffs to unsupported instrument classes. Quotes, watchlists, and existing legacy history routes retain their separate behavior.

## Authorization and provider behavior

The BFF verifies the existing OIDC or explicitly configured terminal-local principal and required action scope before proxying. The MDP bearer is a short-lived `market:read` token with the MDP audience and terminal/research signer identity. `provider_mode=research` additionally requires the existing `research:read` scope. Terminal readiness accepts either the existing full Gateway runtime or a separate terminal MDP signer. A Gateway delegation is attached only for `auto` and `futu_only`, and only as a server-to-server header for the MDP to reuse the already-running local Gateway/Futu surface; its absence does not prevent Alpaca-only reads. Neither token is returned to the browser or written into request metrics.

The browser may select `auto`, `alpaca_only`, or `futu_only` as read-only routing preferences. These values do not grant entitlement or trading authority. `research` is accepted only after server-side scope validation and is not exposed by the current chart selector. Effective execution remains disabled.

## Tests and rollback

`web/e2e/market-bars-bff.spec.ts` exercises default-off compatibility and, when `E2E_MDP_MARKET_BARS_ENABLED=true`, the real same-origin Next BFF route against the isolated bounded loopback MDP fixture. Set `E2E_GATEWAY_SIGNER_DISABLED=true` for the additional case that proves an authorized MDP read still works without the optional terminal Gateway signer. Fixture provenance is explicitly synthetic; it is never evidence of provider availability or entitlement. The fixture supports separate Core envelopes keyed by opaque cursor so continuation behavior can be tested through the same route.

Rollback is immediate: unset `EQO_MDP_MARKET_BARS_ENABLED` or set it to `false`, then restart the OpenTerminal web process. `provider_mode=auto` returns to the existing history route; explicit provider preferences fail with the documented `501` instead of silently selecting a different source. No schema or stored market data migration is required.
