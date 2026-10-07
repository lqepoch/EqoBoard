# EqoBoard 架构

## 运行平面

```
                         ┌──────────────────────────────┐
                         │ OpenTerminal Next.js        │
Browser ────────────────►│ Workspace / Widgets         │
                         │ AG Grid / Charts / Research │
                         └──────────────┬───────────────┘
                                        │ server-side proxy
                                        ▼
Alpaca SIP ──────┐           ┌───────────────────────────┐
Alpaca OPRA ─────┼──────────►│ Rust Tokio/Axum Gateway  │◄──── OpenBB Workspace
                 │           │ source/time/auth/stream   │      widgets/apps
                 │           └─────────────┬─────────────┘
                 │                         │
                 │              preview / audit / route
                 │                         ▼
                 │            ┌─────────────────────────┐
                 └────────────│ BrokerAdapter boundary  │
                              ├ Alpaca Rust service     │
                              ├ IBKR Rust service       │
                              └ Schwab Rust service     │
```

## UI 边界

OpenTerminal 提供 Workspace、Widget 生命周期、Command Palette、Watchlist、Chart、Screener、Heatmap、宏观、日历、SEC/FINRA/新闻等成熟能力。EqoBoard 只维护差异化模块：

- Alpaca SIP/OPRA 适配及服务端代理；
- AG Grid 双边期权链和 50ms 批量实时更新；
- IV Skew、OPRA Tape、垂直价差；
- BrokerAdapter 状态/预览；
- 数据来源、时效、完整性和 entitlement 显示。

旧 Vite UI 已删除。

## Rust 数据接口

- `GET /api/v1/status`
- `GET /api/v1/stocks/snapshots`
- `GET /api/v1/stocks/bars`
- `GET /api/v1/options/chain`
- `POST /api/v1/subscriptions/options`
- `GET /api/v1/stream/sse`
- `POST /api/v1/orders/preview`
- `POST /api/v1/orders/submit`

OpenBB：`/widgets.json`、`/apps.json`、`/openbb/stocks`、`/openbb/options`、`/openbb/bars`。

## 数据原则

SIP/OPRA 是硬约束。关键行情不允许用 Yahoo、IEX、indicative 等源替换后继续标记为 SIP/OPRA。快照、stream、bars 都保留上游时间，缺失字段保持 null。

## 演进

Foundation：OpenTerminal + Rust + AG Grid + OpenBB connector。

Paper MVP：三券商执行服务、订单状态机、撤改单、持仓、成交、对账、恢复。

Production：OIDC/RBAC、持久事件存储、OpenTelemetry/SLO、WORM 审计、行情授权、限额/Kill Switch、灰度和灾备。
