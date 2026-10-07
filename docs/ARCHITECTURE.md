# EqoBoard 架构与演进

## 运行平面

```
Browser
  │
  ▼
OpenTerminal Next.js (apps/openterminal)
  ├─ Workspace / Command Palette / Watchlist / Charts
  ├─ AG Grid OPRA Option Chain
  ├─ IV Skew / OPRA Tape / Vertical Spread
  └─ FRED / SEC / FINRA / News research service
  │ server-side adapter
  ▼
Rust Tokio/Axum Gateway (apps/gateway)
  ├─ Alpaca SIP stocks
  ├─ Alpaca OPRA options
  ├─ 50ms WS/SSE normalized event batches
  ├─ OpenBB Workspace read-only Custom Backend
  └─ BrokerRouter preview / audit / route
       ├─ Alpaca Rust service
       ├─ IBKR Rust service
       └─ Schwab Rust service
```

## 核心接口

- `GET /api/v1/status`
- `GET /api/v1/stocks/snapshots?symbols=SPY,QQQ`
- `GET /api/v1/stocks/bars?symbol=QQQ&timeframe=1Day&days=390&limit=500`
- `GET /api/v1/options/chain?underlying=QQQ&expiration=YYYY-MM-DD`
- `POST /api/v1/subscriptions/options`
- `GET /api/v1/stream`：原浏览器 WS。
- `GET /api/v1/stream/sse`：OpenTerminal Next server 代理使用，50ms batch。
- `POST /api/v1/orders/preview`
- `POST /api/v1/orders/submit`

OpenBB 保持主线已有接口：`/widgets.json`、`/apps.json`、`/openbb/v1/stocks`、`/openbb/v1/bars`、`/openbb/v1/options`。

## 前端复用边界

OpenTerminal 原生应用负责通用终端能力。EqoBoard 维护的差异文件集中在：
- `web/lib/eqo-market.ts`：SIP/OPRA server-side adapter；
- `OptionsWidget.tsx`：AG Grid OPRA；
- `IvSkewWidget.tsx`；
- `OptionTapeWidget.tsx`；
- `VerticalSpreadWidget.tsx`；
- `app/api/eqo/*`：凭据隔离代理。

研究服务中的 Yahoo/Stooq 等 Provider 仅服务补充研究 Widget；Quote、历史股票图、期权链这些核心交易视图由 Next 路由优先截获并转向 Rust。

## 可靠性

- feed 标签与真实请求一致；数据时间戳保留上游值。
- 每类 Alpaca feed 共享少量 Tokio 连接；多个 UI 消费者共享 broadcast。
- OPRA 合约使用 90 秒租约并限制总订阅量。
- 慢客户端触发 `resync_required`，UI 回拉 REST 快照。
- 订单 timeout 归类 UNKNOWN，依赖 client_order_id 对账，避免盲目重复提交。
- 生产阶段引入持久事件存储、OIDC/RBAC、OpenTelemetry、SLO、Kill Switch、灾备与市场数据授权审查。
