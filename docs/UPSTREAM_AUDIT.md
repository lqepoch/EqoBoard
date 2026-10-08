# OpenTerminal upstream file audit

- EqoBoard audit head: `3b07bac28b5c030d4257c94ad13fdd6b3f37a996`
- OpenTerminal upstream commit: `aed097c680cd8ec1c391ae06966babe7d6d91fc6`
- Repository: `ErTasselli/OpenTerminal`
- License: `MIT`
- Verified Git archive SHA-256: `1e10d60a7ea0662d1e84704850a73b531e1a26f69337814f443458d9070a918b` (computed from git archive after the fetched Git object matched the locked commit)
- Audit date (UTC): `2026-10-08 15:05:30 UTC`
- Comparison: tracked files below `apps/openterminal` against the verified Git tree at the locked commit; files such as `node_modules` and `.next` are excluded.

## Summary

- A · exact upstream files: 37
- B · modified upstream files: 38
- C/E · EqoBoard-only files: 95
- C · product extension widgets: 7
- E · domain, security, and integration files: 88
- Deleted upstream files: 14
- D · duplicated mature upstream implementations: none identified in this comparison. EqoBoard routes U.S. SIP/OPRA prices through Rust; retained Yahoo/TradingView providers serve research, non-U.S. symbols, or metadata. The native OpenTerminal Workspace, charts, screener, heatmap, watchlist, and general research widgets remain reused.

C and E are both listed in the EqoBoard-only table. C marks product widgets; E marks data, identity, execution-preview, and integration-specific code. A newly modified or added path without a curated note is labeled `待人工审核` to make drift fail visibly in review.

## A. Exact upstream files

| Category | upstream file | EqoBoard file | upstream commit | modification reason | retain | adapter/extension | duplicate wheel |
|---|---|---|---|---|---|---|---|
| A | `LICENSE` | `apps/openterminal/LICENSE` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/cache.test.ts` | `apps/openterminal/server/src/cache.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/cache.ts` | `apps/openterminal/server/src/cache.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/concurrency.test.ts` | `apps/openterminal/server/src/concurrency.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/concurrency.ts` | `apps/openterminal/server/src/concurrency.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/binance.test.ts` | `apps/openterminal/server/src/providers/binance.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/coingecko.ts` | `apps/openterminal/server/src/providers/coingecko.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/ecb.test.ts` | `apps/openterminal/server/src/providers/ecb.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/ecb.ts` | `apps/openterminal/server/src/providers/ecb.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/econcalendar.ts` | `apps/openterminal/server/src/providers/econcalendar.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/finra.ts` | `apps/openterminal/server/src/providers/finra.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/fred.ts` | `apps/openterminal/server/src/providers/fred.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/nasdaq.ts` | `apps/openterminal/server/src/providers/nasdaq.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/news.ts` | `apps/openterminal/server/src/providers/news.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/registry.ts` | `apps/openterminal/server/src/providers/registry.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/secedgar.ts` | `apps/openterminal/server/src/providers/secedgar.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/stooq.ts` | `apps/openterminal/server/src/providers/stooq.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/tradingview.test.ts` | `apps/openterminal/server/src/providers/tradingview.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/providers/tradingview.ts` | `apps/openterminal/server/src/providers/tradingview.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/rateLimit.test.ts` | `apps/openterminal/server/src/rateLimit.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/rateLimit.ts` | `apps/openterminal/server/src/rateLimit.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `server/src/routes/ai.ts` | `apps/openterminal/server/src/routes/ai.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/app/error.tsx` | `apps/openterminal/web/app/error.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/app/global-error.tsx` | `apps/openterminal/web/app/global-error.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/app/providers.tsx` | `apps/openterminal/web/app/providers.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/components/Flash.tsx` | `apps/openterminal/web/components/Flash.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/components/WidgetErrorBoundary.tsx` | `apps/openterminal/web/components/WidgetErrorBoundary.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/components/widgets/AiWidget.tsx` | `apps/openterminal/web/components/widgets/AiWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/components/widgets/CryptoWidget.tsx` | `apps/openterminal/web/components/widgets/CryptoWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/components/widgets/NewsWidget.tsx` | `apps/openterminal/web/components/widgets/NewsWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/components/widgets/PortfolioWidget.tsx` | `apps/openterminal/web/components/widgets/PortfolioWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/components/widgets/TvWidget.tsx` | `apps/openterminal/web/components/widgets/TvWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/lib/indicators.ts` | `apps/openterminal/web/lib/indicators.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/lib/links.ts` | `apps/openterminal/web/lib/links.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/lib/symbol.ts` | `apps/openterminal/web/lib/symbol.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/next-env.d.ts` | `apps/openterminal/web/next-env.d.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |
| A | `web/postcss.config.mjs` | `apps/openterminal/web/postcss.config.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 与固定上游逐字节一致。 | 保留 | 不需要 | 否 |

## B. Modified upstream files

| Category | upstream file | EqoBoard file | upstream commit | modification reason | retain | adapter/extension | duplicate wheel |
|---|---|---|---|---|---|---|---|
| B | `README.md` | `apps/openterminal/README.md` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 记录 EqoBoard 的数据、安全和部署边界，并移除固定上游未随归档提供的截图引用。 | 保留 | 无需抽 adapter | 否 |
| B | `package-lock.json` | `apps/openterminal/package-lock.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 锁定 EqoBoard 认证和运行时依赖。 | 保留 | 无需抽 adapter | 否 |
| B | `package.json` | `apps/openterminal/package.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 增加现有 OpenTerminal package 中的 research E2E 命令入口；不创建第二套终端。 | 保留 | 测试脚本留在仓库级集成边界 | 否 |
| B | `server/package.json` | `apps/openterminal/server/package.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 加入短时委托 JWT 验证依赖。 | 保留 | 认证职责已在 server/src/auth.ts | 否 |
| B | `server/src/auth.ts` | `apps/openterminal/server/src/auth.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 以 OIDC 用户委托和独立研究服务凭据替代自动生成的共享 API key。 | 保留 | 可抽成认证 adapter | 否 |
| B | `server/src/db.test.ts` | `apps/openterminal/server/src/db.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 覆盖按已验证用户隔离 Portfolio 的数据迁移和访问。 | 保留 | 无需抽 adapter | 否 |
| B | `server/src/db.ts` | `apps/openterminal/server/src/db.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 增加 Portfolio owner 列和不转移旧 local 数据的 SQLite 迁移。 | 保留 | 数据库迁移职责独立 | 否 |
| B | `server/src/index.ts` | `apps/openterminal/server/src/index.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 增加健康检查、委托身份、scope、受限 JSON 和服务端路由边界。 | 保留 | HTTP policy 可逐步拆分 | 否 |
| B | `server/src/providers/binance.ts` | `apps/openterminal/server/src/providers/binance.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 统一显式 crypto 符号归一化；上游仍提供 Binance 数据访问。 | 保留 | 符号规则来自共享 provider adapter | 否 |
| B | `server/src/providers/yahoo.ts` | `apps/openterminal/server/src/providers/yahoo.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 为研究数据补充可空的 source-side observation time。 | 保留 | 无需抽 adapter | 否 |
| B | `server/src/routes/market.test.ts` | `apps/openterminal/server/src/routes/market.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 验证 EqoBoard Gateway 市场数据路由行为。 | 保留 | 无需抽 adapter | 否 |
| B | `server/src/routes/market.ts` | `apps/openterminal/server/src/routes/market.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 让美股/期权关键数据通过 Rust Gateway，并保留上游非美与研究 provider。 | 保留 | 应逐段抽为 Gateway/provider adapter | 否 |
| B | `server/src/routes/portfolio.ts` | `apps/openterminal/server/src/routes/portfolio.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 增加主体隔离、所有权校验及请求限额。 | 保留 | portfolio persistence 可独立 adapter | 否 |
| B | `server/tsconfig.json` | `apps/openterminal/server/tsconfig.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 启用 EqoBoard Node/TypeScript 构建配置。 | 保留 | 无需抽 adapter | 否 |
| B | `web/app/api/[...path]/route.ts` | `apps/openterminal/web/app/api/[...path]/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 加入 OIDC action authorization、短时服务委托、Rust Gateway SIP/OPRA 代理和有界响应。 | 保留 | 可逐步拆为具体 BFF adapters | 否 |
| B | `web/app/globals.css` | `apps/openterminal/web/app/globals.css` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 为登录、会话和身份错误状态提供页面样式。 | 保留 | 无需抽 adapter | 否 |
| B | `web/app/layout.tsx` | `apps/openterminal/web/app/layout.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 设置 EqoBoard 产品名称。 | 保留 | 无需抽 adapter | 否 |
| B | `web/app/page.tsx` | `apps/openterminal/web/app/page.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 以服务端 OIDC 会话门禁包裹上游终端。 | 保留 | Workspace 本体继续复用上游 | 否 |
| B | `web/components/CommandPalette.tsx` | `apps/openterminal/web/components/CommandPalette.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 在原生命令面板增加校验后的 Research 外链；不改变 ticker/search 路由。 | 保留 | 仅传入公开 origin 的窄 UI adapter | 否 |
| B | `web/components/Sidebar.tsx` | `apps/openterminal/web/components/Sidebar.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 将 EqoBoard 专属期权、风险和 Engine 离线预览 widget 注册到上游 Sidebar。 | 保留 | Widget registry 后续可外置 | 否 |
| B | `web/components/Terminal.tsx` | `apps/openterminal/web/components/Terminal.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 把服务端验证的 Research origin 传给上游 Sidebar 与 Command Palette。 | 保留 | 仅传入公开 origin 的窄 UI adapter | 否 |
| B | `web/components/TopBar.tsx` | `apps/openterminal/web/components/TopBar.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 展示 EqoBoard feed/source/授权状态，同时保留上游搜索和时间栏。 | 保留 | 行情状态可作为独立 extension | 否 |
| B | `web/components/Workspace.tsx` | `apps/openterminal/web/components/Workspace.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 在上游 react-grid-layout Workspace 中注册 EqoBoard widgets（含只读 Engine 离线预览）与 ticker linking。 | 保留 | widget 注册表可外置 | 否 |
| B | `web/components/widgets/CalendarWidget.tsx` | `apps/openterminal/web/components/widgets/CalendarWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 呈现研究日历和财报字段的来源与观察时间。 | 保留 | 无需抽 adapter | 否 |
| B | `web/components/widgets/ChartWidget.tsx` | `apps/openterminal/web/components/widgets/ChartWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留 Lightweight Charts，实现 Rust bars 契约和 source/as-of 标签。 | 保留 | bars DTO 转换适合 adapter | 否 |
| B | `web/components/widgets/HeatmapWidget.tsx` | `apps/openterminal/web/components/widgets/HeatmapWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留 D3 heatmap，消费 Gateway SIP 包络并显示 coverage/truncation。 | 保留 | 行包络转换适合 adapter | 否 |
| B | `web/components/widgets/InsiderWidget.tsx` | `apps/openterminal/web/components/widgets/InsiderWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 补充 SEC filing date 与交易观察日期的区分。 | 保留 | 无需抽 adapter | 否 |
| B | `web/components/widgets/MacroWidget.tsx` | `apps/openterminal/web/components/widgets/MacroWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留上游宏观 UI，并显示各 provider 的 source/as-of。 | 保留 | source metadata 可由 adapter 提供 | 否 |
| B | `web/components/widgets/OptionsWidget.tsx` | `apps/openterminal/web/components/widgets/OptionsWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 以 AG Grid Community 展示 OPRA 链，并接入共享行情状态、订阅和 freshness。 | 保留 | 数据/订阅 adapter 可从 widget 拆出 | 否；替换上游旧表格实现 |
| B | `web/components/widgets/QuoteWidget.tsx` | `apps/openterminal/web/components/widgets/QuoteWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留上游 Quote UI，增加 Gateway 快照/实时事件、source 和 freshness。 | 保留 | 市场状态 hook 可外置 | 否 |
| B | `web/components/widgets/RecapWidget.tsx` | `apps/openterminal/web/components/widgets/RecapWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留上游 recap 视图并展示行情来源、coverage 和时间。 | 保留 | source metadata 可由 adapter 提供 | 否 |
| B | `web/components/widgets/ScreenerWidget.tsx` | `apps/openterminal/web/components/widgets/ScreenerWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留上游 screener UI，读取 Gateway SIP 行并显示 coverage/truncation。 | 保留 | 行包络转换可由 adapter 提供 | 否 |
| B | `web/components/widgets/WatchlistWidget.tsx` | `apps/openterminal/web/components/widgets/WatchlistWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留上游 Watchlist UI，消费共享 store 与 Gateway 事件。 | 保留 | 行情 hook 可外置 | 否 |
| B | `web/lib/api-key.ts` | `apps/openterminal/web/lib/api-key.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 移除本地自动生成的静态 API key，改用服务端研究凭据。 | 保留 | 凭据读取 adapter 已有 | 否 |
| B | `web/lib/api.ts` | `apps/openterminal/web/lib/api.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 扩展前端 DTO 以表达 Gateway source、as-of、coverage 和 watermark。 | 保留 | Gateway DTO adapter 可独立 | 否 |
| B | `web/package.json` | `apps/openterminal/web/package.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 加入 NextAuth、jose 与固定 Git SHA 的 trading-core 生成契约依赖。 | 保留 | 认证库沿用上游 Next.js 层；共享 DTO 由 pinned Core 提供 | 否 |
| B | `web/store/terminal.ts` | `apps/openterminal/web/store/terminal.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 保留 Zustand Workspace 状态并增加 EqoBoard widget 类型、交易 preview 与只读 Engine preview 状态。 | 保留 | 行情/金融状态继续在独立 market/domain store | 否 |
| B | `web/tsconfig.json` | `apps/openterminal/web/tsconfig.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 为 EqoBoard 的跨层 DTO 类型导入启用扩展配置。 | 保留 | 无需抽 adapter | 否 |

## C. EqoBoard extension widgets

| Category | upstream file | EqoBoard file | upstream commit | modification reason | retain | adapter/extension | duplicate wheel |
|---|---|---|---|---|---|---|---|
| C | — | `apps/openterminal/web/components/widgets/EngineOfflinePreviewWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 只读 synthetic Engine 状态预览；复用原生 Workspace，并经服务端 BFF 读取生成契约。 | 保留 | 是，继续作为 EqoBoard UI extension | 否 |
| C | — | `apps/openterminal/web/components/widgets/IvSkewWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 专属期权分析/preview widget；复用 Workspace 与 AG Grid/图表容器。 | 保留 | 是，继续作为 EqoBoard UI extension | 否 |
| C | — | `apps/openterminal/web/components/widgets/MarketFeedStatus.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 行情来源、授权、ACK 与 freshness 状态展示组件。 | 保留 | 是，继续作为 EqoBoard UI extension | 否 |
| C | — | `apps/openterminal/web/components/widgets/OptionTapeWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 专属期权分析/preview widget；复用 Workspace 与 AG Grid/图表容器。 | 保留 | 是，继续作为 EqoBoard UI extension | 否 |
| C | — | `apps/openterminal/web/components/widgets/OrderOutcomePanel.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 专属期权分析/preview widget；复用 Workspace 与 AG Grid/图表容器。 | 保留 | 是，继续作为 EqoBoard UI extension | 否 |
| C | — | `apps/openterminal/web/components/widgets/ResearchPredictionsWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 只读展示注册研究 run 的受限公开投影；不请求私有 envelope，未知证据与禁止 promotion 状态保持可见。 | 保留 | 是，继续作为 EqoBoard UI extension | 否 |
| C | — | `apps/openterminal/web/components/widgets/VerticalSpreadWidget.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 专属期权分析/preview widget；复用 Workspace 与 AG Grid/图表容器。 | 保留 | 是，继续作为 EqoBoard UI extension | 否 |

## D. Duplicate implementations

| Category | upstream file | EqoBoard file | upstream commit | modification reason | retain | adapter/extension | duplicate wheel |
|---|---|---|---|---|---|---|---|
| D | — | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 本次逐文件审计未发现需要删除的重复成熟 Workspace、布局、图表、表格或研究框架实现。 | 无删除项 | 不适用 | 否 |

## E. EqoBoard domain and integration files

| Category | upstream file | EqoBoard file | upstream commit | modification reason | retain | adapter/extension | duplicate wheel |
|---|---|---|---|---|---|---|---|
| E | — | `apps/openterminal/AGENTS.md` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | OpenTerminal 子目录的 EqoBoard 数据来源、身份和上游同步约束。 | 保留 | 不适用 | 否 |
| E | — | `apps/openterminal/Dockerfile` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 容器、安全头和离线浏览器验证配置。 | 保留 | 不适用 | 否 |
| E | — | `apps/openterminal/openbb-research-ingress.conf` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 仅 Research origin 使用的内部 auth_request 入口；将受控 Lite UI 与精确 BFF 路由隔离。 | 保留 | 部署边界适配，不重写 OpenBB UI | 否 |
| E | — | `apps/openterminal/server/src/auth.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/server/src/providers/eqo-sip.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/eqo-sip.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/market-source.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/market-source.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/market-symbol.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/market-symbol.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/market-time.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/market-time.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/snapshot-watermarks.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/providers/snapshot-watermarks.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/server/src/routes/market-http.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Gateway/订单权限与协议集成测试。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/server/src/routes/market-store.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Gateway/订单权限与协议集成测试。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/server/src/routes/order-contract.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Gateway/订单权限与协议集成测试。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/server/src/routes/portfolio.test.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 为 Portfolio 路由测试使用独立临时 SQLite DATA_DIR，并清理数据库及 WAL/SHM 文件，避免污染源码树。 | 保留 | 测试代码，不适用 | 否 |
| E | — | `apps/openterminal/web/app/api/auth/[...nextauth]/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard OIDC 会话与上游终端之间的认证适配。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/engine/preview/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Engine 离线读取的固定 GET BFF；仅终端专属委托可访问，复用 Core 生成契约并限制为 loopback 上游。 | 保留 | 是，作为 Next-to-Engine 只读 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/engine/status/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Engine 离线读取的固定 GET BFF；仅终端专属委托可访问，复用 Core 生成契约并限制为 loopback 上游。 | 保留 | 是，作为 Next-to-Engine 只读 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/live/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | SSE BFF 在授权等待前建立客户端断连监听，取消后不启动 Gateway 请求，并把 AbortSignal 传递到 Rust 上游流。 | 保留 | 是，作为用户会话边界与 Rust SSE 的窄传输 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/market-data/datasets/[datasetId]/bars/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 通过独立 MDP 短时委托读取受限历史 bars；保留 diagnostic/unknown 来源边界。 | 保留 | 是，作为 Next-to-MDP 只读 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/options/subscribe/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway BFF 代理、市场订阅或健康状态路由。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/orders/[action]/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway BFF 代理、市场订阅或健康状态路由。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/research/predictions/[runId]/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 通过独立 Quant research 委托读取注册 run 的公开预测投影；私有 artifact 不进入浏览器。 | 保留 | 是，作为 Next-to-Quant 只读 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/eqo/stocks/subscribe/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway BFF 代理、市场订阅或健康状态路由。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/healthz/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway BFF 代理、市场订阅或健康状态路由。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/openbb/[...path]/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research-only OpenBB manifest/market API allowlist；从 OIDC role 会话签发最长 60 秒 market:read Gateway 委托。 | 保留 | 是，作为 Next-to-Gateway market adapter | 否 |
| E | — | `apps/openterminal/web/app/api/readyz/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust Gateway BFF 代理、市场订阅或健康状态路由。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/app/api/research/auth-check/route.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 供内部 Nginx auth_request 校验 research cookie/role；不签发或返回 Gateway token。 | 保留 | 是，作为入口认证 adapter | 否 |
| E | — | `apps/openterminal/web/app/e2e/order-outcome/page.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/auth.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard OIDC 会话与上游终端之间的认证适配。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/components/MarketStreamProvider.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust MarketEvent、订阅租约和行情状态扩展。 | 保留 | 是，继续作为行情 domain/extension | 否 |
| E | — | `apps/openterminal/web/components/SignInButton.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard OIDC 会话与上游终端之间的认证适配。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/components/SignOutButton.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard OIDC 会话与上游终端之间的认证适配。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/components/TerminalShell.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard OIDC 会话与上游终端之间的认证适配。 | 保留 | 是，继续作为 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/access-boundary.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/compose-e2e-server.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/engine-offline-preview.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/fixtures.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/fixtures/engine-status-response-v1.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/fixtures/prediction-envelope-v1.synthetic.protojson` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/fixtures/synthetic-offline-preview-v1.json` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/isolated-env.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/market-data-bff.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/market-data-chart.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/market-freshness.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/market-order.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/market-stream.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/market-test-data.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/mdp-upstream.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/mock-openbb-alpaca.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 仅 E2E 的有控制 token fixture；市场响应显式模拟，Gateway source 保持 unknown，不作真实行情声明。 | 保留 | 仅测试 fixture，不进入产品运行路径 | 否 |
| E | — | `apps/openterminal/web/e2e/mock-openbb-oidc.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 仅 E2E 的有控制 token fixture；市场响应显式模拟，Gateway source 保持 unknown，不作真实行情声明。 | 保留 | 仅测试 fixture，不进入产品运行路径 | 否 |
| E | — | `apps/openterminal/web/e2e/mock-services.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/openbb-core-availability.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/openbb-lite.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/openbb-recovery.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/openbb-response-capture.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/order-outcome-probe.tsx` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/quant-upstream.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/research-bff.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/research-navigation.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/research-origin.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Research 身份、OpenBB 原生 Lite、Gateway 数据与回滚的隔离浏览器/契约验证；不实现另一套 Workspace。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/e2e/research-prediction.spec.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。 | 保留 | 无需抽 adapter | 否 |
| E | — | `apps/openterminal/web/lib/client-abort.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 将客户端断连信号跨授权等待传到 BFF 下游控制器，断连时不启动后续请求，并向运行中的上游流传递 AbortSignal。 | 保留 | 是，作为窄的 BFF transport adapter | 否 |
| E | — | `apps/openterminal/web/lib/client-abort.test.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 覆盖授权等待中的断连竞态及已断开的请求，确保断连后不会执行授权后的下游调用。 | 保留 | 测试代码，不适用 | 否 |
| E | — | `apps/openterminal/web/lib/engine-preview.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 验证专属 OIDC role 并签发 Engine-only 短时委托；固定 loopback GET、响应体上限、超时及 Core strict ProtoJSON parser。 | 保留 | 是，作为认证和只读 transport adapter | 否 |
| E | — | `apps/openterminal/web/lib/eqo-auth.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/eqo-market.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/http-response.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/mdp-market-data-contract.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/mdp-market-data.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/order-api.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/order-contract.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/permissions.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/quant-prediction-contract.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/quant-predictions.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。 | 保留 | 是，继续作为 adapter/domain | 否 |
| E | — | `apps/openterminal/web/lib/research-origin.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 限制 Research hostname、origin、session 与精确 API allowlist；研究模式其余路径失败关闭。 | 保留 | 是，作为 research auth/policy adapter | 否 |
| E | — | `apps/openterminal/web/lib/research-route-access.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 限制 Research hostname、origin、session 与精确 API allowlist；研究模式其余路径失败关闭。 | 保留 | 是，作为 research auth/policy adapter | 否 |
| E | — | `apps/openterminal/web/middleware.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 限制 Research hostname、origin、session 与精确 API allowlist；研究模式其余路径失败关闭。 | 保留 | 是，作为 research auth/policy adapter | 否 |
| E | — | `apps/openterminal/web/next-auth.d.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard SIP/OPRA、身份、安全或集成专属扩展。 | 保留 | 是，继续作为 extension/domain | 否 |
| E | — | `apps/openterminal/web/next.config.mjs` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 容器、安全头和离线浏览器验证配置。 | 保留 | 不适用 | 否 |
| E | — | `apps/openterminal/web/playwright.compose.config.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 容器、安全头和离线浏览器验证配置。 | 保留 | 不适用 | 否 |
| E | — | `apps/openterminal/web/playwright.config.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard 容器、安全头和离线浏览器验证配置。 | 保留 | 不适用 | 否 |
| E | — | `apps/openterminal/web/playwright.openbb.config.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 将原生 OpenBB 与 Research BFF 浏览器套件限制在各自目标服务和环境 allowlist。 | 保留 | 测试配置，不适用 | 否 |
| E | — | `apps/openterminal/web/playwright.research.config.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 将原生 OpenBB 与 Research BFF 浏览器套件限制在各自目标服务和环境 allowlist。 | 保留 | 测试配置，不适用 | 否 |
| E | — | `apps/openterminal/web/store/market.ts` | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | EqoBoard Rust MarketEvent、订阅租约和行情状态扩展。 | 保留 | 是，继续作为行情 domain/extension | 否 |

## Deleted upstream files

| Category | upstream file | EqoBoard file | upstream commit | modification reason | retain | adapter/extension | duplicate wheel |
|---|---|---|---|---|---|---|---|
| deleted | `.claude/launch.json` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 上游本地助手配置未随终端 vendoring；不是产品运行能力。 | 当前不保留 | 不适用 | 否 |
| deleted | `.github/workflows/ci.yml` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | CI 统一由 EqoBoard 仓库根工作流管理。 | 当前不保留 | 不适用 | 否 |
| deleted | `.gitignore` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 忽略规则由 EqoBoard 仓库根管理。 | 当前不保留 | 不适用 | 否 |
| deleted | `data/readme.md` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 上游本地数据目录未随终端 vendoring；Portfolio 存储由容器卷配置。 | 当前不保留 | 不适用 | 否 |
| deleted | `docker-compose.yml` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 容器拓扑由 EqoBoard 根 compose 管理。 | 当前不保留 | 不适用 | 否 |
| deleted | `docs/screenshots/chart.png` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 固定上游归档未提供该截图；README 中对应的失效图片引用已删除，图表功能说明保留。 | 当前不保留 | 不适用 | 否 |
| deleted | `docs/screenshots/crypto.png` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 固定上游归档未提供该截图；README 中对应的失效图片引用已删除，Crypto 功能说明保留。 | 当前不保留 | 不适用 | 否 |
| deleted | `docs/screenshots/dashboard.png` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 固定上游归档未提供该截图；README 中对应的失效图片引用已删除，Workspace 功能说明保留。 | 当前不保留 | 不适用 | 否 |
| deleted | `docs/screenshots/heatmap.png` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 固定上游归档未提供该截图；README 中对应的失效图片引用已删除，heatmap 功能说明保留。 | 当前不保留 | 不适用 | 否 |
| deleted | `docs/screenshots/news.png` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 固定上游归档未提供该截图；README 中对应的失效图片引用已删除，news 功能说明保留。 | 当前不保留 | 不适用 | 否 |
| deleted | `server/Dockerfile` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 镜像构建由 apps/openterminal/Dockerfile 集中管理。 | 当前不保留 | 不适用 | 否 |
| deleted | `web/Dockerfile` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | Next.js 与 server 构建由 apps/openterminal/Dockerfile 集中管理。 | 当前不保留 | 不适用 | 否 |
| deleted | `web/next.config.ts` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 由 EqoBoard 的 next.config.mjs 替代以配置 BFF 安全头。 | 当前不保留 | 不适用 | 否 |
| deleted | `web/tsconfig.tsbuildinfo` | — | `aed097c680cd8ec1c391ae06966babe7d6d91fc6` | 生成的 TypeScript 增量构建状态不纳入版本控制。 | 当前不保留 | 不适用 | 否 |
