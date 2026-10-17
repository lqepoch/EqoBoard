# EqoBoard Pine Script plugin foundation

Status: independent read-only contract package. It contains zero PineTS runtime code, zero user editor UI and zero deployed script execution endpoint. Track https://github.com/lqepoch/EqoBoard/issues/72.

Purpose: eventual Pine Script v5/v6 indicators on the existing EqoBoard Lightweight Charts 5.x terminal using source-licensed compatible engines. The package can validate source declarations, OHLCV arrays and resulting plot data, and adapt an externally installed reviewed PineTS instance. It never initiates market data requests or order submission.

## Components

- src/contract.mjs validates v5/v6 indicator-only source, strict finite sorted OHLCV, output plot timestamps/values and size caps.
- src/runtime.mjs requires explicit data-source provenance and an injected engine, converts results to read-only ChartSeries shapes.
- src/pinets-adapter.mjs accepts a separately licensed and pinned PineTS constructor only after the host attests it runs in a sandbox and licensing is resolved.
- src/index.d.ts exposes TS contracts; the package itself has no installed runtime dependency.
- tests/protocol.test.mjs uses deterministic synthetic candles and a **fake engine**, not PineTS or TradingView goldens.
- .github/workflows/pine-script-plugin.yml runs an offline no-credentials Node gate.

Run local tests with: node --test packages/pine-script-plugin/tests/*.test.mjs

IMPORTANT: sandbox assertions and tests are not OS isolation. No app may execute untrusted Pine within the Next server/browser/MDP/OMS. Full implementation awaits license approval, OS process isolation, authenticated BFF and chart integration. See docs/PINE_SCRIPT_PLUGIN.md and issue #72.

TradingView Community Script publication permissions, author attribution and any MPL-2.0 code terms require validation before ingestion. Don't scrape protected or invite-only scripts.

The current plot normalizer supports only simple lines and zero-baseline histograms, and passes through price/indicator pane intent. Other plot styles and drawing objects fail explicitly. This foundation does not yet render either style into the main EqoBoard chart.
