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

OpenBB：`/widgets.json`、`/apps.json`、`/openbb/v1/stocks`、`/openbb/v1/options`、`/openbb/v1/bars`。三类数据路由返回 Workspace table 使用的 flat row arrays。每行包含 `source` / `source_mode` / `source_label`、实际 `feed`、市场字段的 `market_as_of`、页数及 `has_more` / `truncated`。股票 row 另含请求覆盖及 snapshot/price/time completeness；bars 的 `market_as_of` 等于 Alpaca bar 时间；期权 quote、trade、model 时间分离，当前没有专用模型时间时 `model_as_of` 保持 null。上游页数有限制，错误 OHLCV 行会使请求失败，不会静默丢弃或填入零。

只有使用内置 `https://data.alpaca.markets` 时，OpenBB row 才声明 `source_mode=alpaca`；任何 `EQO_MARKET_DATA_BASE_URL` 覆盖都显示来源 unknown。OpenBB 普通 table 的 `refetchInterval` 只是 HTTP polling，不构成 Live Grid。期权默认日期使用 Workspace 动态日期修饰符，不保留固定到期日。空结果保持空数组，不追加伪记录；因此无数据行时，Workspace 表格没有行可呈现分页字段。

OpenBB 研究行情 handler 要求带 `market:read` scope 的可验证短时委托主体；`/widgets.json` 和 `/apps.json` 只返回兼容 schema metadata，不授予行情访问能力。OpenBB Workspace 的 OIDC 登录/服务委托联调属于后续 #13，当前不接受静态 bearer token，也不通过放宽 Gateway 鉴权来兼容。

## 数据原则

SIP/OPRA 是硬约束。关键行情不允许用 Yahoo、IEX、indicative 等源替换后继续标记为 SIP/OPRA。快照、stream、bars 都保留上游时间，缺失字段保持 null。

## 演进

Foundation：OpenTerminal + Rust + AG Grid + OpenBB connector。

当前基础版只开放离线订单预览，Paper 与 Live 提交固定关闭。Paper MVP 还需三券商持久订单状态机、一次性 preview/outbox、账户身份、撤改单、持仓、成交、对账与恢复后另行验收。

Gateway preview 记录绑定验证后的 `(idp_iss, sub)`，相同 `sub` 但不同 issuer 不共享或消费 preview。当前 preview 仍是进程内一次性记录，不是持久 ledger。submit 的错误使用 `state/retryable/recovery_required/detail` 契约；上游结果不确定时返回 `UNKNOWN` 并保留原 `client_order_id`，不能引导换 ID 重下。status 中的 `adapter_endpoints_configured` 只描述 endpoint 配置；`broker_capabilities` 对 Alpaca、IBKR、Schwab 的 Paper 与 Live 均明确 disabled，Schwab 不映射为真实券商 Paper。

Production：OIDC/RBAC、持久事件存储、OpenTelemetry/SLO、WORM 审计、行情授权、限额/Kill Switch、灰度和灾备。

## 实时流治理

OpenTerminal 由单一 `MarketStreamProvider` 建立 SSE。所有 Widget 从共享 Zustand market store 消费事件；Option Chain 继续使用 AG Grid `applyTransactionAsync`，由 AG Grid 自身约 50ms 合并事务。Watchlist/Quote 不进行 1 秒 REST 轮询，15 秒快照只承担校准和日线字段补全。

股票和期权订阅都使用 90 秒租约，30 秒续租。浏览器关闭或 Widget 删除后主动释放，异常退出最多在 TTL 后回收。Rust 对多个浏览器/Widget 求订阅并集，只维持每个 feed 的共享上游连接。
