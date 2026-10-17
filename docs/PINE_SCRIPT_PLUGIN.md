# EqoBoard Pine Script compatibility plugin — Architecture Decision

Date: 2026-10-17
State: CONTRACT FOUNDATION ONLY; no deployed runtime, editor, or TradingView parity claim.
Tracking: https://github.com/lqepoch/EqoBoard/issues/72

## Ownership and integration

The standalone packages/pine-script-plugin package owns source admission, engine-neutral evaluation/output contracts, display-projection validation and optional adapters. apps/eqoboard-web owns the future editor, workspace widgets, BFF auth and chart renderer. Existing apps/openterminal and apps/desk remain unchanged.

The nine-repository boundaries remain authoritative: market-data-platform owns source/entitlement, Core Bars history and provenance; trading-core owns exact finance schemas; quant-research owns PIT/OOS testing and candidate research; trading-engine alone can eventually authorize account orders. Script code and local chart numbers cannot call brokers.

Future architecture:
- User editor -> authenticated EqoBoard BFF -> tenant quotas and reviewed script store.
- BFF -> separate sandbox process with approved licensed Pine engine, bounded validated MDP bars and immutable provenance.
- Sandbox -> validated display-only series result -> existing ChartSurface overlays/panes.
- Orders and live alerts remain disabled, regardless of the script text.

## Third-party reuse

1. LuxAlgo/PineTS (manifest 0.11.1 as inspected 2026-10-17) supports Pine v5/v6 transpilation and runtime in TypeScript, with native syntax experimental. Public source license is AGPL-3.0-only, with separately offered commercial license. This repository does not install, vendor or bundle that runtime. AGPL/commercial review must precede integration; directory/module isolation does not automatically remove AGPL obligations. Source https://github.com/LuxAlgo/PineTS and commercial text https://github.com/LuxAlgo/PineTS/blob/main/LICENSE-COMMERCIAL.md.
2. PyneSys/pynecore has an Apache-2.0 Python runtime but native Pine source requires separately evaluated PyneComp translation/API, cost, data transfer and uptime evaluation. Source https://github.com/PyneSys/pynecore.
3. Opus-Aether-AI/pine-transpiler has MIT license and emits PineJS CustomIndicator factories for TradingView Advanced Charts. Requires the proper TradingView chart license, targets a different host API and does not directly integrate with Lightweight Charts. Source https://github.com/Opus-Aether-AI/pine-transpiler.
4. LuxAlgo/Vela and Vela-pinets would add a second chart renderer and licensing obligations; postpone until performance/graphics coverage demonstrates a need.

Official TradingView charting library custom studies API accepts JS PineJS custom studies; it does not embed a complete Pine Script interpreter. Source https://www.tradingview.com/charting-library-docs/latest/custom_studies/.

## Current package scope

Bounded indicator() source admission with explicit v5/v6 marker, validated historical OHLCV with seconds-to-milliseconds conversion, output timestamp/finite-value validation, explicit source provenance and read-only normalized line plots. Unknown/missing engine, strategies, cross-timeframe requests or invalid output fail closed. No runtime is actually installed or called by the deployed app.

Security note: 'isolatedProcess' argument on adapter is a deployment attestation flag and cannot itself create a sandbox. Before production runtime, enforce an OS-level separate identity/process, no egress, no secrets or provider tokens, CPU/memory/wallclock hard caps with process termination, durable audit, script ownership, per-tenant quotas and a rollback flag. Never use untrusted code eval within Next.js or its browser worker with accessible session/broker context.

## Planned acceptance gates

A. Package source/plot contract and offline negative/positive test; narrow and fail-closed. [This PR]
B. License approval, pinned engine and hashes/SBOM; isolated worker image, no-egress/secret-leak tests, OS timeout kill/restart, no engine defaults.
C. Versioned authenticated API, editor, templates and legal user-script imports, revision store, input controls, overlays/panes/shapes, existing viewport/snapshot generation, redraw on corrected bars, workspace persistence and rolling deployment.
D. Golden numerical parity corpus, at least 100 legally reproducible scripts, v5/v6, ta/array/input/state/MTF/barmerge/plotshape/labels and real-time/repaint cases. Record failures per feature, not just aggregate claims.
E. Optional strategies/alerts only after lookahead prevention, PIT source, session/adjustment validation, an entirely separate strategy permission and future Engine risk/OMS integration.

Cache keys must include engine digest, source hash, input arguments, symbol/timeframe, dataset manifest, adjustment/session policies and provenance/entitlements; avoid showing cached unknown as LIVE.

Community Script reuse requires source/author/URL/license/consent/SHA provenance. No automatic downloading of protected/invite-only TradingView source. Per-author legal terms and TradingView publication conditions apply.

Rollback is removal of script feature from the native chart and termination of sandbox workers, retaining encrypted tenant scripts and audit per retention policy. Existing chart data and legacy deployment must remain operable. Paper/Live remains disabled.

The initial adapter recognizes PineTS simple line and zero-baseline histogram plot metadata, preserving overlay/indicator pane identity. Other styles (including shape, linebr, columns, drawing objects), offset, nonzero histogram base and show_last are rejected with UNSUPPORTED_PLOT_STYLE rather than silently converted into a line. This does not supply renderer integration or official visual parity.


## Isolated worker harness (#74, phase B slice)

Implemented in `packages/pine-script-plugin/src/isolated-worker.mjs` and `src/worker-child.mjs`:

- The worker is a separate Node process started with `--permission` (filesystem reads limited to the package and the pinned engine file, no filesystem writes, no child processes) and an empty environment (`PATH` empty, `NODE_ENV=production`). It has no broker, provider or service credentials.
- The engine is an explicitly configured module pinned by SHA-256. A digest mismatch stops before evaluation. No engine is configured by default, so the worker fails closed with `ENGINE_UNAVAILABLE`.
- Admission requires an explicit attestation (`DEV_HARNESS_ATTESTATION` in this release). Without it the worker refuses to start with `SANDBOX_NOT_ATTESTED`. The development value exists only for local tests.
- Per-tenant concurrency quota (`QUOTA_EXCEEDED`). Request and response sizes are bounded.
- Timeout, output overrun and process death kill the whole process group with SIGKILL and reap it. The reported pid is no longer alive afterwards.

Tested with fixture engines (not Pine engines): timeout kill, heap exhaustion, output overrun, denied child process creation, denied writes outside the worker, unbounded recursion, missing engine identifier, digest mismatch, quota, and environment scrubbing.

Not done, and required before any production enablement:

- Node's permission model does not restrict the network. Egress must be blocked by an OS-level sandbox (for example a container with no network and a read-only root filesystem, or macOS sandbox profiles), then attested through the production attestation path. The harness does not prove that by itself.
- No real Pine engine is vendored or executed. PineTS (AGPL-3.0 or commercial) and PyneCore remain pending legal approval.
- Container and seccomp hardening, cgroup CPU and memory limits, restart and replay tests, and the tenant-facing authorization path are not implemented here.
- Native chart integration (#75) and the TradingView compatibility matrix (#76) are not started.
