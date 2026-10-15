# Yahoo daily research chart

The optional Yahoo Finance chart runs only on the separately validated Research hostname at
`/research/yfinance/{SYMBOL}`. The terminal exposes a link from its main chart when
`EQO_RESEARCH_PUBLIC_ORIGIN` passes the existing origin validation. Without that configured origin the link is disabled
with a visible reason. The OpenBB Lite root and the strict terminal `/api/history/{symbol}` data path remain separate.

The page reuses the existing `ChartWidget`, its Lightweight Charts instance, drawing-independent chart styles, and shared
SMA/EMA/VWAP/RSI/MACD/Bollinger calculations. It requests one symbol at a time and daily bars only. The range buttons
choose UTC calendar windows (1D uses 7 calendar days, 5D 14, 1M 45, 6M 200, YTD starts January 1, 1Y 366, 5Y 1,827,
and MAX starts at 1970-01-01); they do not claim exchange-session coverage. MAX is requested as one full range and loaded
newest-first in bounded pages. `Load older` and chart panning pass the opaque cursor together with the unchanged full
range. The browser stops after 10 pages, matching the MDP endpoint bound, and labels the result incomplete when another
cursor remains. Refresh Snapshot starts a new full-range snapshot and does not replay old cursors. Yahoo history does
not auto-poll or accept quote pushes.

The browser calls only the same-origin Research BFF route:

```text
GET /api/research/yfinance/daily
  ?symbols=AAPL
  &asset_class=stock
  &start_utc=2010-01-01T00:00:00Z
  &end_utc=2026-01-01T00:00:00Z
  &adjustment=unadjusted
  [&cursor=<opaque>]
```

The BFF requires the OIDC `research:read` scope, mints a short `market:read` MDP token using the isolated Research
signer, and forwards the query to `GET /v1/research/yfinance/daily`. It never sends a Gateway delegation, terminal
signing key, order scope, or provider credential. The upstream envelope and its original bridge payload are validated
without translating the observations to Bars V1. The BFF accepts UTC `Z` or `+00:00` timestamps, compares range bounds
at nanosecond precision, then forwards canonical `Z` timestamps; cursor requests retain those same full-range bounds.
HTTP 200 represents a non-empty page, not complete history; a typed upstream failure remains an error. The Research
BFF enforces a 35-second upstream deadline, allowing the stock bridge's bounded 31-second fetch deadline to return its
typed timeout first. The source-observation hash is displayed as an MDP-reported hash, not as a Yahoo signature or
independent verification receipt.

The chart labels provider and source, while feed, delay, and provider verification remain unknown or unavailable. It
also labels `provider_adjustment_semantics=unknown_or_provider_native`, `adjustment_confirmed_raw=false`,
`numeric_encoding=binary_float_projection`, `canonical=false`, `point_in_time=false`, `executable=false`,
`display_only=true`, and `mdp_coverage_asserted=false`. The requested `unadjusted` or `adjusted` parameter is not proof
of the actual price basis. Source decimal strings are converted to bounded finite numbers for drawing; exact source
decimals are not shown in the tooltip. Invalid or missing required OHLCV values fail the projection without filling or
inventing bars. Coverage gap codes remain provider observations; `calendar_gaps_assessed=false` means the chart cannot
label them as exchange-calendar gaps. Yahoo pages are never mixed with Alpaca/Futu history or live quote data.

The route allowlist and `openbb-research-ingress.conf` admit only this page, the chart's GET endpoint, and bounded
`/_next/static` GET/HEAD assets. The existing internal `/api/research/auth-check` path stays hidden from browsers; all
unlisted Research API routes and order paths remain denied. Access logging is disabled only for the history endpoint
because its query contains a principal-bound opaque pagination cursor; other ingress paths retain their existing logs.
The page has its own host-only OIDC session on the separate hostname.

The Research E2E uses the real Next BFF/page with a bounded synthetic MDP HTTP fixture. It verifies signer claims,
unchanged cursor windows, 2010–2026/pre-2016 pages, MAX left-pan cursor pagination with viewport preservation,
adjustment query identity, nanosecond-safe ordering across 2001, duplicate/reversed bar rejection, unknown-basis labels,
and float-only tooltips. The OpenBB profile E2E also traverses the
Research Nginx ingress for the Yahoo page's anonymous callback, daily API authentication gate, and an unauthenticated
static Next.js chunk. These bounded synthetic tests validate routing and display behavior only. They do not verify
Yahoo availability, real provider adjustment behavior, historical completeness, exchange-calendar gaps, source
freshness, or production Research identity configuration. Run the Research browser suite in public GitHub Actions after
the workflow's normal web build; do not use its synthetic result as real-provider evidence.
