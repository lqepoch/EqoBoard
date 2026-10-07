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
Alpaca OPRA ─────┼──────────►│ Rust Tokio/Axum Gateway  │◄──── isolated research BFF
                 │           │ source/time/auth/stream   │      OpenBB manifests/data
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

主终端浏览器只访问 OpenTerminal BFF。Next 使用固定 OIDC issuer 的 PKCE/state 会话，把 allowlist role 映射为每请求 action scope 的短时委托；Gateway 校验 issuer、audience、kid、签名、有效期和 scope。OpenBB 是可选研究工作台，部署时必须使用独立 research origin 和 research-mode Next BFF；它只持有独立 research signer，经过用户 OIDC 会话与 `market:read` role 校验后签发最长 60 秒的 `market:read` 子 token。research runtime 不配置终端 BFF signer 或 Node API key，且只放行认证、健康检查、OpenBB manifests 和三条只读行情路径。它与主终端隔离，因此关闭研究服务不影响 OpenTerminal、Gateway 或订单 preview。客户端身份头和静态 `EQO_ACCESS_TOKEN` 不构成认证。

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

OpenBB Gateway 接口为 `/widgets.json`、`/apps.json`、`/openbb/v1/stocks`、`/openbb/v1/bars`、`/openbb/v1/options`。三类数据路由返回 Workspace table 使用的 flat row arrays，每行包含 `source` / `source_mode` / `source_label`、实际请求 `feed`、市场字段的 `market_as_of`、页数及 `has_more` / `truncated`。股票 row 另含请求覆盖与 snapshot/price/time completeness；bars 的 `market_as_of` 等于 bar 时间；期权 quote、trade、model 时间分离，没有专用模型时间时 `model_as_of` 保持 null。只有使用内置 `https://data.alpaca.markets` 时才声明 Alpaca；任意 `EQO_MARKET_DATA_BASE_URL` 覆盖均显示来源 unknown。

Gateway 有界消费 bars/options continuation token；缺失/null 表示终止，非空字符串表示续页，其他值使请求失败。无法解析的 OCC 符号、到期日与请求不一致及错误 OHLCV 行也会使请求失败，不静默丢弃或填零。页预算耗尽且仍有后续页但没有行情行时返回带来源和分页状态的 502；完整空结果仍返回 `200 []`，不追加占位行。OpenBB 普通 table 的 `refetchInterval` 只是 HTTP polling，不构成 Live Grid。

隔离 research BFF 对外提供 `/api/openbb/widgets.json`、`/api/openbb/apps.json` 及 `/api/openbb/openbb/v1/{stocks,bars,options}`。重复的 `openbb` path segment 来自 pinned Workspace `createURLString(endpoint, backendUrl)` 规则：custom source URL 是 `/api/openbb`，manifest endpoint 保持 `openbb/v1/...`。BFF 只映射这三条只读路径，要求隔离 hostname 上的 OIDC/NextAuth session 和 market-reader role，再使用 research signer 签发最长 60 秒、`kid=research`、`iss=openterminal-research`、`aud=eqoboard-gateway`、单一 `market:read` scope 的 token。manifest metadata 不授予行情访问能力；source、feed、as-of 和 truncation 来自 Gateway。

Research BFF 不配置主终端 Gateway signer、Node API key 或 Alpaca key/secret。现有 research BFF Playwright suite 是生产 Next 与 mock OIDC/Gateway 的组件测试；它不运行 OpenBB Lite，不能替代真实 Lite 浏览器集成验收或 SIP/OPRA 行情来源证明。

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
