<div align="center">

# OpenTerminal

**A source-aware research workspace for SIP, OPRA, macro and company data.**

Dark. Dense. Keyboard-driven. Provider entitlements and source timestamps remain visible.

[![Stack](https://img.shields.io/badge/stack-Next.js%20%2B%20Express%20%2B%20TypeScript-orange)](#tech-stack)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Source-aware data](https://img.shields.io/badge/data-source%20aware-blue)](#data-sources)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](#contributing)

<a href="https://trendshift.io/repositories/215916?utm_source=trendshift-badge&utm_medium=badge&utm_campaign=badge-trendshift-215916" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/215916/daily?language=TypeScript" alt="ErTasselli%2FOpenTerminal | Trendshift" width="250" height="55"/></a>

<br/>

<img src="docs/screenshots/dashboard.png" alt="OpenTerminal dashboard — live chart, quote panel, watchlist, news and macro indexes" width="100%" />

<sub>⭐ If this is useful to you, consider starring the repo — it genuinely helps other people find it.</sub>

</div>

<br/>

## Why OpenTerminal?

OpenTerminal is the native workspace inside EqoBoard. It keeps research providers useful while routing U.S. market prices through the configured Alpaca SIP feed and option quotes/trades through OPRA.

Research sources such as FRED, ECB, SEC, FINRA, news and selected international-market providers remain separate and identify their source and observation time. A missing SIP/OPRA entitlement is shown as unavailable; research prices are never substituted for U.S. SIP data.

<br/>

## ✨ Features

- 🖥️ **Widget-based workspace** — drag, resize, add, and remove panels (`react-grid-layout`); your layout is saved locally and restored on reload
- ⌘K **global command palette** — instantly search stocks, ETFs, and crypto and jump straight to them
- 📈 **Professional charting** (via [`lightweight-charts`](https://github.com/tradingview/lightweight-charts)) — candlesticks, bars, line, area, volume, 8 timeframes (1D → MAX), and SMA / EMA / VWAP / Bollinger Bands / RSI / MACD indicators, each with a live hover legend showing OHLC, volume, and every active indicator's value under your cursor
- 💹 **Quote panel** — last / bid / ask / OHLC, volume, market cap, P/E, EPS, dividend yield, 52‑week range, beta, shares outstanding
- 📰 **News feed** — aggregated and de‑duplicated from multiple RSS sources, per‑symbol or global
- 🔎 **Full‑market screener** — filter by sector, market cap, % change, and volume across the entire US equity market, sortable on every column
- 🗺️ **Live sector heatmap** — treemap sized by market cap, colored by daily % change, refreshing every few seconds
- ⛓️ **Options chain** — AG Grid Community calls and puts with strike, quote status, IV and Greeks; vendor/model fields are labeled separately from OPRA quotes
- 🪙 **Crypto board** — top assets with 7‑day sparklines, BTC/ETH dominance, and full OHLCV charting for any listed coin
- 🏦 **Macro dashboard** — live US Treasury yield curve, VIX, and major index/commodity proxies
- 💼 **Portfolio tracker** — log buy/sell transactions, track average cost, realized & unrealized P&L (persisted in SQLite)
- 📅 **Calendar** — economic events (Fed, ECB, CPI, NFP and more) with consensus forecast, previous reading and, for the major US/EU releases, the actual outcome; plus a per‑watchlist earnings calendar with click‑through history showing forecast vs. actual EPS for the last several quarters and the stock's next‑day price move
- 🤖 **AI assistant** (optional) — ask questions about the symbol you're looking at, powered by Claude, fully context‑aware of the terminal's current data
- ⚡ **Market status** — browser SSE, upstream authentication, ACK coverage and event freshness are separate; server `fresh_until` or a documented client fail-safe expires silent LIVE values
- ⌨️ **Keyboard shortcuts** everywhere — `⌘K` to search, `⌥1`–`⌥9` to add any widget

<br/>

## 📸 A closer look

### Charting

Candlesticks, bars, line, or area — 8 timeframes, six technical indicators, and a live legend under your cursor showing OHLC, volume, and every active indicator's value for the candle you're pointing at.

<img src="docs/screenshots/chart.png" alt="Candlestick chart with SMA/RSI/MACD indicators and hover legend" width="100%" />

<br/>

### Live sector heatmap

The whole US equity market as a treemap — sized by market cap, colored by daily % change, refreshing every few seconds so nothing you're watching ever goes stale.

<img src="docs/screenshots/heatmap.png" alt="Live sector heatmap of the US equity market" width="100%" />

<br/>

### Crypto

Top assets with 7‑day sparklines and BTC/ETH dominance — click through to full OHLCV candlestick charting for any listed coin, same charting engine as stocks.

<img src="docs/screenshots/crypto.png" alt="Crypto board with sparklines and dominance" width="100%" />

<br/>

### News

Headlines aggregated and de‑duplicated across multiple sources, filterable per‑symbol or global, so you're never digging through five tabs to catch up.

<img src="docs/screenshots/news.png" alt="Per-symbol and global news feed, aggregated and de-duplicated" width="100%" />

<br/>

## 🗂️ Data sources

U.S. equity/ETF price, change, volume, history and earnings price-move fields use Alpaca SIP through the Rust Gateway. Option quote/trade fields use Alpaca OPRA. SIP/OPRA access depends on server-side credentials and account entitlement. A denied or unavailable feed is an explicit error; no IEX, indicative or research-price fallback is used.

Option IV and Greeks come from Alpaca REST snapshot vendor/model fields, not OPRA itself. Until Alpaca supplies a separate model timestamp, the UI reports `model as-of unknown`; Gateway response time and quote/trade event time are not treated as model time. Research providers retain their own source and observation dates.

See [`../../docs/MARKET_SOURCES.md`](../../docs/MARKET_SOURCES.md) for the field-by-field source, as-of, coverage and failure contract. In particular, metadata timestamps may be unavailable, FRED/ECB dates are observation dates, and a connected browser is not proof that an upstream feed is ready.

<br/>

## 🚀 Quick start

```bash
git clone https://github.com/lqepoch/EqoBoard.git
cd EqoBoard
cp .env.example .env
# Set the OIDC, Gateway signing and server-side market-data values described in the root deployment guide.
docker compose up --build
```

- OpenTerminal UI → **http://localhost:3000**
- Rust Gateway liveness → **http://localhost:8080/healthz** (liveness is not market readiness)

This is the OpenTerminal subproject, not a standalone free-data deployment. Follow the repository root deployment guide for OIDC, Gateway signing, server-only data credentials and readiness checks. Without valid server-side credentials/entitlement, U.S. market data is unavailable by design.

### Optional: AI assistant

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Without a key, everything else still works — the AI widget just shows a friendly "unavailable" message instead of failing.

Two optional knobs for the assistant, both standard for the Anthropic SDK:

- `ANTHROPIC_BASE_URL` — point the assistant at an Anthropic-compatible endpoint (a self-hosted gateway, an EU-hosted relay, etc.) instead of api.anthropic.com.
- `ANTHROPIC_MODEL` — override the model sent in requests (default: `claude-opus-4-8`). Required when the endpoint behind `ANTHROPIC_BASE_URL` serves models under different ids.

### Security defaults

- Browser requests use the OIDC session and action-specific authorization enforced by the Next.js BFF. User identity and delegated service identity are distinct; browser code never receives a Gateway token.
- Gateway credentials, Alpaca keys and research signing keys stay in server-side runtime configuration. Do not put them in `NEXT_PUBLIC_*`, client storage, fixtures or PR CI.
- Write requests require same-origin validation and bounded JSON. Gateway accepts a verifiable delegated principal, not a client-provided identity header.
- Portfolio reads and writes require a verified OIDC principal with the matching workspace scope. Rows are isolated by issuer and subject; existing `local` rows are not automatically reassigned to a user. The Node API also requires its private service key plus a short-lived signed user delegation from the Next BFF.
- Portfolio routes are limited to 120 requests/minute per verified owner and 1,200 requests/minute per research process. The in-memory limiter is process-local; multi-process deployments need a shared store or an equivalent trusted ingress limit. The `/api/ai` limit remains 10 requests/minute by `req.ip`. Requests through the bundled web proxy share that proxy address by default; set `TRUST_PROXY=1` only behind a trusted reverse proxy that overwrites client forwarding headers.
- Keep the API private to the Compose network or loopback. Do not expose it directly to the internet or use a browser-shared API key; expose only the TLS-protected Next BFF and configure the service identity through the deployment guide.
- The `/api/ai` rate limit (10 req/min) keys on `req.ip`. Calls made through the bundled web proxy all arrive from that proxy's own address, so by default every caller sharing it shares one bucket. If you're serving more than one real user through it, set `TRUST_PROXY=1` on the api process **only if** you also run your own reverse proxy in front of the web service that sets `X-Forwarded-For` from the real client and doesn't let visitors set it themselves — otherwise a caller can forge that header to dodge the limit.
- Paper submission and Live execution remain disabled in this release. A valid preview does not authorize order submission.

<br/>

## 🐳 Docker

```bash
cd ../..
cp .env.example .env
# Configure required OIDC and server-only credentials before starting services.
docker compose up --build
```

Portfolio data persists in the `terminal-data` volume (SQLite, WAL mode). Ports are published on `127.0.0.1` only by default; see [Security defaults](#security-defaults) to expose it deliberately.

<br/>

## 🧱 Tech stack

| Layer | Stack |
|---|---|
| Frontend | Next.js 15 · React 19 · TypeScript · Tailwind CSS 4 · Zustand · TanStack Query |
| Charts | `lightweight-charts` (candles/indicators) · D3 (heatmap treemap) · Recharts (yield curve) |
| Backend | Node.js · Express · TypeScript |
| Database | SQLite (`better-sqlite3`, WAL mode) |
| AI | Anthropic Claude (optional) |

<br/>

## 📁 Project structure

```
├── server/                  # Express + TypeScript API
│   └── src/
│       ├── providers/       # nasdaq, tradingview, yahoo, stooq, fred, econcalendar, coingecko, binance, news
│       ├── routes/          # market, portfolio, ai
│       ├── cache.ts         # TTL cache with stale-while-revalidate fallback
│       └── db.ts            # SQLite (better-sqlite3, WAL)
└── web/                      # Next.js 15 + React 19 + Tailwind 4; only user-facing terminal
    ├── components/           # TopBar, Sidebar, Workspace, CommandPalette
    ├── components/widgets/   # Chart, Quote, Watchlist, News, Screener, Heatmap, Crypto, Options, Macro, Portfolio, Calendar, AI
    ├── lib/                  # API client, technical indicators
    └── store/                # Zustand store (workspace layout, persisted)
```

Run tests with `npm test` (Vitest, no network calls). CI runs on every push — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

<br/>

## 🗺️ Roadmap

- [ ] Chart drawing tools & multi‑asset comparison overlay
- [ ] Black‑Scholes Greeks on the options chain
- [ ] Price alerts with desktop notifications
- [ ] PostgreSQL as an alternative to SQLite

Have an idea? [Open an issue](../../issues) — contributions are very welcome.

<br/>

## 🤝 Contributing

Pull requests are welcome, especially:
- New or more resilient data providers (`server/src/providers/`)
- New widgets (`web/components/widgets/`)
- Bug fixes and UI polish

Please open an issue first for anything non‑trivial so we can align on approach before you invest the time.

<br/>

## Known limitations

- `npm audit` still flags two dependency advisories this project doesn't force-fix: `fast-xml-parser`'s XMLBuilder injection (moderate) doesn't apply here — only `XMLParser` is used, never `XMLBuilder` — and `postcss`'s high-severity issue is bundled inside Next.js itself, only resolved by a Next 16 major upgrade. Both are tracked, neither is silently ignored.
- If you deploy behind a reverse proxy or load balancer, set `API_HOST`/`WEB_ORIGIN` to match, and terminate TLS in front of it — this project doesn't handle HTTPS itself.

<br/>

## ⚖️ Disclaimer

For personal and educational use only. Market data comes from public endpoints and may be delayed, incomplete, or occasionally wrong — **do not use this for real investment decisions**.

This project is not affiliated with, endorsed by, or sponsored by any of the data providers it connects to. It does not host or redistribute data to third parties — it's source code you run yourself, fetching data directly from the provider. Respect the terms of service of the underlying data providers; most free sources are licensed for personal/research use only and prohibit commercial redistribution.

## License

[MIT](LICENSE)

<br/>

<div align="center">

**star the repo** ⭐ — it's the best way to support the project.

</div>
