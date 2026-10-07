# EqoBoard 架构

## 运行平面

```
                         ┌──────────────────────────────┐
                         │ OpenTerminal Next.js        │
Browser ── OIDC cookie ─►│ BFF / Workspace / Widgets  │
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

浏览器只访问 Next BFF。Next 使用固定 OIDC issuer 的 PKCE/state 会话，把 allowlist role 映射为每请求 action scope 的短时委托；Gateway 校验 issuer、audience、kid、签名、有效期和 scope。research Node 仅持有独立 research signer，只能为通过用户会话验证的市场读取请求签发 `market:read` 子 token。客户端身份头和静态 `EQO_ACCESS_TOKEN` 不构成认证。

## Rust 数据接口

所有受保护 Gateway 路由都要求可验证委托主体；`/healthz` 仅表示进程存活，`/readyz` 表示身份 keyring 可用。行情配置和 SIP/OPRA 授权另行判断，身份 readiness 不等于市场数据 ready。

- `GET /api/v1/status`
- `GET /api/v1/stocks/snapshots`
- `GET /api/v1/stocks/bars`
- `GET /api/v1/options/chain`
- `POST /api/v1/subscriptions/stocks`：活动股票/Watchlist 租约，和启动基础标的求并集。
- `POST /api/v1/subscriptions/options`：OPRA 合约租约。
- `GET /api/v1/stream/sse`：50ms 批量的统一股票/期权浏览器事件总线。
- `POST /api/v1/orders/preview`
- `POST /api/v1/orders/submit`

OpenBB：`/widgets.json`、`/apps.json`、`/openbb/stocks`、`/openbb/options`、`/openbb/bars`。
OpenBB Gateway 路由也要求可验证的委托主体；OpenBB Lite 的登录/令牌交换联调属于后续 #13，当前不接受静态 bearer token。

## 数据原则

SIP/OPRA 是硬约束。关键行情不允许用 Yahoo、IEX、indicative 等源替换后继续标记为 SIP/OPRA。快照、stream、bars 都保留上游时间，缺失字段保持 null。

## 演进

Foundation：OpenTerminal + Rust + AG Grid + OpenBB connector。

当前基础版只开放离线订单预览，Paper 与 Live 提交固定关闭。Paper MVP 还需三券商持久订单状态机、一次性 preview/outbox、账户身份、撤改单、持仓、成交、对账与恢复后另行验收。

Production：OIDC/RBAC、持久事件存储、OpenTelemetry/SLO、WORM 审计、行情授权、限额/Kill Switch、灰度和灾备。

## 实时流治理

OpenTerminal 由单一 `MarketStreamProvider` 建立 SSE。所有 Widget 从共享 Zustand market store 消费事件；Option Chain 继续使用 AG Grid `applyTransactionAsync`，由 AG Grid 自身约 50ms 合并事务。Watchlist/Quote 不进行 1 秒 REST 轮询，15 秒快照只承担校准和日线字段补全。

股票和期权订阅都使用 90 秒租约，30 秒续租。浏览器关闭或 Widget 删除后主动释放，异常退出最多在 TTL 后回收。Rust 对多个浏览器/Widget 求订阅并集，只维持每个 feed 的共享上游连接。
