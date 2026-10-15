# Native terminal migration acceptance

This is the cutover contract for `apps/eqoboard-web`. A passing local check,
synthetic fixture, or matching file tree is not migration acceptance. The
candidate stays disabled and the existing `apps/openterminal` deployment stays
the production entrypoint until the required evidence is bound to one frozen
candidate SHA and accepted by the repository owner.

## Baseline and evidence binding

The audited comparison source is the OpenTerminal tree at
`fea1e952add7a11e799d6f9f198ddcee47fd12b6`
(`986dd808560016965e73edc1869603b621b4286e`), bound by
`references/legacy/manifest-fea1e952.json`. The manifest protects 219 source
files but does not establish feature or release acceptance. The audit inventory is based on
`apps/openterminal/web/store/terminal.ts`, `components/Terminal.tsx`,
`components/terminal/ModernTerminal.tsx`, and their six panel components. The
native branch inherits that frozen source commit. If PR59 or another source
change is merged before the candidate is frozen, refresh the inventory and
bind the acceptance manifest to the resulting exact source SHA and tree. Do not
call the old audit SHA the final baseline without that check.

Every evidence record must include the candidate commit, baseline commit where
comparison applies, lockfile digest, CI workflow/run, runner image, browser
version, and fixture digest. Keep each outcome as `PASS`, `FAIL`, `NOT_RUN`,
`BLOCKED_EXTERNAL`, or `UNKNOWN`; do not convert missing evidence into a pass.
The production Compose helper validates `NATIVE_CANDIDATE_SHA` against the
checked-out source HEAD and passes it as `E2E_CANDIDATE_SHA`; browser timing
attachments reject a missing or malformed source-head SHA. Do not substitute a
GitHub merge-ref SHA for the candidate source commit.
Public builds, unit/component/API/browser/security/container checks run in
GitHub Actions. This work does not run local tests, a build, a browser, Docker,
or provider probes.

## Test lanes and current proof state

`tests/parity/**` owns the legacy widget-to-static-registry mapping;
`tests/security/**` covers the closed browser/API boundary;
`tests/migration/**` covers workspace validation, ownership-client behavior,
CAS recovery, explicit import, and rollback; `e2e/**` uses the real signed OIDC
redirect flow against the isolated CI mock issuer and drives the production
Compose image. The mock Gateway is test-network-only, returns clearly marked
synthetic fixtures, and exposes per-upstream-path counters. The security unit
lane invokes the real route handlers behind a denied permission adapter and
spies on `fetch`, covering Gateway, MDP, Quant, Engine, and research-provider
dispatch boundaries. The anonymous browser lane checks each protected
operation path and every recognized Gateway dispatch path. Do not add a
test-auth bypass or public reset route.

The candidate-only browser samples record observed navigation, usable-shell,
first validated Yahoo chart render, and workspace save/reload timings and
transfer sizes. The Yahoo sample is bound to the supplied candidate source SHA,
browser version, fixture response size, and response SHA-256. Signed-in
workspace acceptance also observes the layout-only export payload. These are
candidate telemetry, not latency gates. Until the old deployment is available in the same Actions
job, same-runner paired performance is `NOT_RUN`; that status blocks cutover.
Auth, route, ownership, workspace, migration, and browser assertions now have
source tests, but execution on the frozen candidate head remains `NOT_RUN`.
The `/api/eqo/live` source route now requires `market:stream`, signs the fixed
short-lived Gateway delegation, and bounds each connection by the earlier
session or delegation expiry. Browser acceptance covers the signed OIDC
host-stream connection, the anonymous 401 path, and rejection of query
extensions before another Gateway dispatch. The CI Gateway serves a
comment-only empty event stream: it proves transport and delegation wiring but
contains no market events and does not establish market-data correctness.
Provider-generation/lease runtime qualification and release rollback evidence
remain `NOT_RUN`. No test file added in this change has been run locally.

The terminal browser suite uses `e2e/fixture-server.mjs` for isolated OIDC and
Gateway services. The OIDC fixture generates an in-memory RS256 key per
process and completes the standard signed redirect flow with PKCE, state,
nonce, and fixed reader, writer, or workspace-only identities; it adds no
app-side test login or role header. The Gateway fixture validates the app's
short-lived delegated JWTs, returns empty data or explicit unavailable
responses labeled `test-fixture`, and has no broker, provider, order-submit,
quote, bar, depth, or tape data connector. Its counter control paths are
exposed only to the runner on an ephemeral loopback port. Each Compose run gets
an isolated database volume; tests do not use an HTTP database reset route.

Research-mode Yahoo acceptance runs the same native image at the separate
`http://localhost:3441` origin while the terminal uses
`http://127.0.0.1:3440`. Hostnames are intentionally distinct because
host-only cookies are shared across ports. The research runtime has its own
NextAuth secret and MDP signer key and accepts only the exact fixture
`EQO_PUBLIC_ORIGINS` loopback allowlist. The CI-only `e2e/mdp-fixture.mjs`
service binds `0.0.0.0:4452` inside the Compose network, validates the
research-scoped short-lived delegation, and serves only the fixed
`/v1/research/yfinance/daily` route. Its bounded, deterministic observations
are synthetic acceptance fixtures with an explicit synthetic adapter label;
they are not Yahoo data, provider validation, or a source-quality claim. The
fixture control API is exposed to the runner only on an ephemeral loopback
port. Terminal-mode Yahoo calls must return 404 before MDP dispatch; anonymous
and insufficient-scope Research calls must return 401/403 with zero MDP
dispatch and zero delegation. The signed Research reader also requests
terminal-only quote, status, stream, order-preview, Engine, and workspace
routes; they must return 404 before the Gateway dispatch counter changes. A
Research reader may reach the fixture with
only `market:read`, and the observed payload must preserve its
noncanonical/non-PIT/non-executable/display-only flags and unknown adjustment
semantics. These assertions are source-only until the production Compose lane
passes on the frozen head.

Current browser assertions exercise anonymous route denial and zero Gateway
dispatch, actual OIDC role selection, secret-sentinel absence, cross-origin and
stale workspace writes, competing ETag compare-and-swap, reader/writer
workspace and manual-portfolio isolation, cross-tab logout, fixed same-origin
stream authorization, shell keyboard and mobile navigation, metadata-only
symbol search through a same-origin synthetic response with keyboard focus and
workspace selection, explicit legacy-layout preview/import, fresh imported
IDs, inert unsupported tiles, persistent tabs, tab deletion followed by local
recovery restore and a persisted reload, and layout-only export. A reader role
also receives 403 for private
prediction and Engine routes. The workspace-only fixture identity is also used
to test the 403-before-MDP Research boundary. The browser recovery assertion
restores a partition-scoped pre-delete snapshot; a source unit test separately
proves that failed replacement backup leaves the current document unchanged.
The current host-isolation browser test checks cookie/session isolation between
the terminal and Research hostnames. The route-level Yahoo API test verifies
three cursor-linked pages and adjacent window bounds using the marked synthetic
MDP fixture. The visible Research chart now has browser source assertions for
anonymous zero-dispatch, visible source and synthetic-fixture provenance,
display-only/noncanonical/non-PIT/nonexecutable facts, non-live chart mode,
local SMA projection, ten-page explicit cursor loading, and absence of
provider or broker browser requests. The existing order-book browser check
also asserts no provider/broker requests for unsupported depth. These source
assertions do not count as a passed Actions run or production rollback proof.

## Source-declared request and resource caps

These values are read from the current native source and are evidence inputs,
not adopted production budgets. They have not been load-tested or qualified
across multiple web instances. The per-process server limiters require a shared
deployment limiter before horizontal scaling is considered verified.

| Boundary | Current source setting | Evidence status |
| --- | --- | --- |
| Widget read client | 120 requests per minute, 8 global concurrent, 3 per operation; operation-specific response caps from 512 KiB to 4 MiB | `NOT_RUN` under candidate Actions |
| Widget poll scheduler | 8 global concurrent, 3 per operation, 1 per widget; 120 global, 90 per user, 30 per operation and widget per minute; 1 second minimum interval | `NOT_RUN` under candidate Actions |
| Core Bars | 60 requests per principal and 600 per process per minute; 1,000 rows/page; 4,096-byte query, 2,048-byte cursor, 4 MiB response, 30-second upstream deadline | `NOT_RUN`; provider-generation and entitlement evidence separate |
| Research data | Per-principal per-minute caps: news 30, macro/calendar/earnings-calendar 12, earnings-history 8, insider 6, screener/heatmap 4, crypto 20, crypto-global 10 | `NOT_RUN`; provider calls are not made by the CI fixture |
| Research AI | 10 requests per principal per minute; 16 KiB request body and 64 KiB provider response | `NOT_RUN`; the current CI issuer fixture lacks `eqoboard-research-ai-reader`, and production issuer assignment plus Anthropic provider access remain unverified |
| Workspace | 120 requests per principal per minute; 64 KiB document | `NOT_RUN` under candidate Actions |
| Manual portfolio | 120 requests per principal and 1,200 per process per minute; 100 portfolios per owner and 10,000 transactions per portfolio | `NOT_RUN` under candidate Actions |
| Live stream | 20 connects per principal and 600 per process per minute; 2 open streams per principal, 100 per process; 5-second connect deadline | `NOT_RUN` beyond the one-stream transport assertion; process-local caps are not deployment-wide |
| Market leases | Client aggregate caps: 1,000 stock symbols and 16 option contracts; renew every 30 seconds; options ACK must match the active generation | `NOT_RUN` in this candidate browser lane; local source tests are not runtime proof |

The paired performance report must separately record observed request counts,
payload sizes, cache mode, runner limits, browser version, and timing
distribution. These caps do not define latency, throughput, provider
entitlement, or production capacity budgets.

## Product parity inventory

The legacy Workspace exposes these 20 widget types. The parity suite keeps
this inventory as test data and maps each item to a native manifest or an
explicit, reviewed unavailable/retired state. It never imports executable
legacy modules.

| Legacy widget | Native acceptance |
| --- | --- |
| `quote` | Show only decoded quote data with source, as-of and coverage; otherwise show unavailable/unknown. |
| `chart` | Accept typed Core Bars V1 history only; preserve source, gaps and attribution. No quote/tape-derived bars. |
| `watchlist` | Preserve symbols, ordering and active selection as workspace data; no fabricated quotes. |
| `news` | Keep source and timestamps visible; empty/denied results stay empty or unavailable. |
| `heatmap` | Render only a supported, decoded read operation; otherwise show an explicit unavailable state. |
| `screener` | Render only a supported, decoded read operation and preserve partial coverage. |
| `crypto` | Preserve the source boundary; no equity-feed substitution. |
| `macro` | Preserve source and observation time; missing provider data stays unavailable. |
| `options` | Keep OPRA source/entitlement/coverage separate from SIP; obey generation, cap and lease contracts. |
| `ivskew` | Preserve independent model timestamp and unknown model-as-of state. |
| `optiontape` | Require typed OPRA trades; never synthesize tape rows. |
| `vertical` | Preview only through the closed preview operation; no submit or execution claim. |
| `portfolio` | Require owner-scoped API data; anonymous and other-owner requests reveal no records. |
| `ai` | Do not leak private context or silently turn denied data into a successful answer. |
| `calendar` | Preserve provider/time facts or display unavailable. |
| `insider` | Preserve provider/time facts or display unavailable. |
| `tv` | Remain inert/unavailable until a registered implementation has a reviewed source and license contract; do not mount an untrusted embed. |
| `recap` | Preserve the provenance and coverage of each input; partial inputs stay partial. |
| `researchpredictions` | Read-only observation; no promotion, mutation, or execution authority. |
| `enginepreview` | Offline synthetic diagnostic only; unknown source, no account/market-loaded or trading claim. |

The old default workspace contains `chart`, `options`, `quote`, `watchlist`,
`ivskew`, `optiontape`, `vertical`, `news`, and `macro`. The acceptance suite
checks that each configured widget either resolves to a versioned built-in
renderer or to an inert unavailable state. Unknown manifests, versions, or
config schemas must never cause code loading or network activity.

The separate old Pro view is composed from six user-facing paths:

| Pro path | Legacy source | Acceptance boundary |
| --- | --- | --- |
| Header, symbol and account summary | `components/terminal/TerminalHeader.tsx` | Preserve navigation and symbol intent; do not carry its seeded account value as real. |
| Watchlist | `components/terminal/WatchlistPanel.tsx` | Preserve user symbols and selection; do not carry hard-coded quotes as market evidence. |
| Main chart and studies | `components/terminal/MainChartPanel.tsx` | Use only typed history; preserve source/gap/time and chart attribution. |
| Order book and tape | `components/terminal/OrderBookPanel.tsx` | Both remain explicitly unavailable until typed, entitled source contracts exist; no simulated rows. |
| Paper ticket and positions/orders | `components/terminal/PaperTradingPanel.tsx` | Preview is read-only; no seeded account, `FILLED`, paper-ready, submit, or order-history migration. |
| Feed/status bar | `components/terminal/TerminalStatusBar.tsx` | Show measured source/entitlement/freshness or unknown; no invented quota/connection status. |

The legacy `/api/futu/*` implementation is not a valid market or trading
baseline. It exposes anonymous simulated quote/depth/tape/account responses,
`PAPER_READY`, and in-memory `FILLED` responses. Native route/browser checks
must prove that these values and requests do not enter the native app or its
exported state. Native execution remains disabled, and browser tests must
observe zero broker/order endpoint dispatches.

## Identity, routes, and browser boundary

The server verifies the current issuer, subject, expiry, role, and required
permission on every BFF request. The browser receives only the closed
`AuthUiSnapshot` projection. It never receives access tokens, raw roles,
issuer/subject identifiers, database owner hashes, or provider/broker keys.
`storagePartition` is an HMAC derived with HKDF from the server-only
`NEXTAUTH_SECRET`, with fixed versioned purpose, runtime mode, issuer, and
subject inputs. It partitions client recovery state only; it cannot
authenticate or select server-owned data. Rotating `NEXTAUTH_SECRET` changes
the partition and resets identity-scoped in-memory UI state. Existing local
recovery data remains under its old partition and is not adopted or migrated;
the database owner key remains the existing issuer-plus-subject SHA-256 value.

OIDC roles are copied from the verified issuer claims into the encrypted
NextAuth session at sign-in. Each BFF request revalidates that session, its
issuer, and expiry, but does not introspect the issuer for role changes. A role
revocation therefore takes effect when the session expires, capped by the
provider expiry and `EQO_SESSION_TTL_SECONDS` (default one hour, configured
maximum 24 hours). This is a bounded stale-role window, not immediate
revocation.

Terminal AI access requires the trusted OIDC issuer to explicitly assign
`eqoboard-research-ai-reader`, which grants only `research:ai`. The ordinary
market-reader role does not imply AI access, and the AI role grants no market,
workspace, order, or execution permission. Users who need workspace or market
features must receive those separate roles. Research runtime filters
`research:ai` from its UI snapshot and does not expose the terminal AI route.
Production issuer assignment and Anthropic provider access remain unverified
and are not Native acceptance.

The route/API lane must cover every published route and method with its exact
permission, input bounds, same-origin write checks, response schema, cache
policy, and downstream operation. In particular:

- unauthenticated, wrong-role, expired-session, policy-rejected, cross-origin,
  wrong-content-type, oversized, malformed, and stale-write requests fail
  before a protected downstream call;
- browser-supplied identity, role, owner, or partition headers never change
  the authenticated principal;
- all market access goes through the single client data host and its closed
  operation map; no arbitrary URL/path proxy is available;
- `/api/futu/order` is absent or returns the documented disabled/404 response,
  and no order or broker dispatch occurs;
- logout clears the session and user-scoped client caches/state; another tab
  and another principal cannot read the prior owner's server workspace;
- the internal research auth-check endpoint is not publicly reachable.

Production browser acceptance also checks a fresh nonce for each terminal and
Research document, matches the nonce-bound scripts to the response CSP, and
requires `strict-dynamic`, `frame-ancestors 'none'`, and frame denial without
`unsafe-eval`. JSON API denials remain `no-store` and must not receive page CSP,
nonce, or `Set-Cookie` material. A separate terminal browser case requests one
anonymous document and then one document after the signed OIDC redirect; it
checks that the visible auth projection changes per request, each response has
a distinct CSP nonce matching its inline hydration scripts, and the command
palette is interactive in both documents.

Use only deterministic mock OIDC/Gateway adapters and synthetic market
fixtures. E2E browser interception must assert that no provider or broker host
is contacted. A unique test-only secret sentinel may be injected by the
server-side fixture; prove it is absent from rendered HTML, client JS, URLs,
browser storage, cookies, and API response bodies. Never load real credentials.

## Source, coverage, freshness, generations, and quotas

The native read-operation boundary is closed to the IDs
`market.quotes`, `market.options.chain`, `market.status`,
`market.history.core-bars`, `market.archive.diagnostic-bars`,
`research.yahoo.daily`, `research.predictions`, `engine.status`,
`engine.preview`, `research.news`, `research.macro`,
`research.economicCalendar`, `research.earningsCalendar`,
`research.earningsHistory`, `research.insider`, `research.screener`,
`research.heatmap`, `research.crypto`, `research.cryptoGlobal`,
`portfolio.list`, `portfolio.positions`, and `portfolio.transactions` in
`features/data/operations.ts`. Preview, AI, and manual-ledger mutations are
separate fixed actions: `orders.preview.vertical`, `research.ai`,
`portfolio.create`, `portfolio.delete`, `portfolio.transaction.create`, and
`portfolio.transaction.delete`; they are not arbitrary POST/DELETE proxies.
The live stream uses the same-origin `/api/eqo/live` route. The security
contract test pins every operation's exact path and permission. The mapped
route sources are present in this candidate, but route runtime acceptance is
still `NOT_RUN` until the production Compose browser/API lane passes on the
frozen head. The widget layer cannot make direct provider/broker requests.
Subscription generation and lease management are host-owned stream behavior,
not widget operations.

Maintain these source rules in contract/API and browser fixtures:

- U.S. equity quotes and Core history retain their actual SIP/source facts;
  option quotes/trades retain OPRA source and entitlement facts;
- IV/Greeks model time remains separate from quote time;
- Yahoo, diagnostic archives, and other research observations remain distinct
  from canonical/entitled market data and cannot drive execution;
- a missing source, denied entitlement, unknown timestamp, stale event, invalid
  generation, or incomplete coverage stays unavailable/partial/unknown with
  no cross-provider fallback;
- the UI contains no fabricated live bars, depth, tape, quotes, account, quota,
  or successful order result. History-only bars do not establish live-bar
  support; no depth contract means an explicit unsupported state.

Generation/epoch tests must delay an older REST response and stream event until
after a newer workspace symbol or Gateway generation is active. The stale
response must not overwrite the new state. A Gateway restart clears old
freshness, ACK/cap, and stream values. An options lease is accepted only for a
current valid generation and known server-issued cap; browser intent or an old
cap cannot create a new lease. Coverage tests must distinguish requested,
returned, priced, timestamped, and missing rows and must preserve provider
gaps.

For every route and subscription, the acceptance report records the actual
configured rate/concurrency/body/response/time budget and measured dispatch
count. Add a boundedness assertion for invalid/missing limits (zero provider
dispatch). Do not copy the legacy Pro's displayed `40/60` or Futu route's
`0/100` as quota evidence. Do not invent numeric limits: a limit without a
source/configuration owner remains `UNKNOWN` and blocks production cutover.

## Workspace ownership, migration, and rollback

The v1 document is strict, versioned, bounded to 64 KiB, and limited to 12
workspaces, 12 tabs per workspace, 24 widgets per tab, 100 watchlist symbols,
24 templates, 12 columns, and 500 rows. Browser and server use the same
structural parser. Unknown fields, unsafe keys, invalid references, overlap,
oversize documents, and unsupported versions are rejected rather than silently
rewritten.

Server workspace ownership comes only from verified issuer plus subject.
`GET /api/workspaces` requires `workspace:read` and returns its schema version,
revision, nullable document, and ETag. `PUT /api/workspaces` requires
`workspace:write`, same-origin validation, bounded JSON, and `If-Match`; an
initial revision is zero, a successful save advances the revision, and stale
or missing revision tokens return 412 without overwriting current state.
Competing requests from the same owner must prove atomic compare-and-swap; a
different owner must never observe or alter that document.

Local recovery snapshots are partitioned by the opaque auth snapshot. They are
not credentials. Anonymous legacy layouts remain in their original storage
until the user previews and explicitly confirms import. Import creates fresh
IDs, validates the full document, rechecks unchanged source bytes at
confirmation, and does not claim server ownership before the signed-in server
save succeeds. E2E covers both a successful explicit import and a source change
between preview and confirmation; the latter must leave the owner document
unchanged. Export is a strict workspace envelope and
contains no auth/session, account, order, broker, or market-data payload.
Tests must cover interrupted import, failed CAS, reload/recovery, and a second
identity in a separate tab/profile.

Before cutover, capture a checksum of the old workspace storage and a verified
database backup plus schema version. Rollback must restore the old route/config
and demonstrate that the original workspace and owner-scoped portfolio state
are readable. A failed or disabled native rollout leaves the existing app and
original data intact. Legacy source, patches, notices, licenses, and data are
not deleted as part of acceptance.

## Performance evidence

There is no invented latency or throughput budget. The Actions report must
capture actual metrics with the same runner image, browser version, lockfile,
CPU/memory limits, fixture payloads, and cache mode for the frozen baseline and
candidate, run sequentially in the same job. Separate cold and warm samples.
Report sample count, median, p95, and request/payload counts for server
readiness, first usable workspace render, chart fixture render, a representative
multi-widget view, workspace save/load, and each route family. Bind the report
to both SHAs and fixture digest. If a paired baseline is unavailable or the
inputs differ, performance is `NOT_RUN`; synthetic fixture timing is not a
real-provider performance claim. Investigate changes against measured
run-to-run variation and report the actual numbers before deciding whether
they are acceptable.

## Cutover gate

Cutover requires passing parity, route/security, data ownership/CAS, source and
freshness, generation/coverage/quota, migration, rollback, and same-runner
performance evidence on the exact candidate head. External provider/entitlement
qualification is reported separately as `BLOCKED_EXTERNAL` where no safe
provider proof exists. If any gate is `FAIL`, `NOT_RUN`, or `UNKNOWN`, retain
the current production entrypoint and do not remove the legacy app. A synthetic
test pass cannot establish live SIP/OPRA entitlement, real Futu availability,
or order execution.
