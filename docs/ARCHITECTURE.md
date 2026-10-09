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

历史归档分钟 bars 使用独立的 MDP read API：OpenTerminal 与 research Next BFF 以各自的短时 `market:read` 委托调用 MDP，浏览器不持有 MDP token，也不直连归档。该接口不是 Gateway 行情流、账户 entitlement 或订阅 ACK 的替代品。

## UI 边界

OpenTerminal 提供 Workspace、Widget 生命周期、Command Palette、Watchlist、Chart、Screener、Heatmap、宏观、日历、SEC/FINRA/新闻等成熟能力。EqoBoard 只维护差异化模块：

- Alpaca SIP/OPRA 适配及服务端代理；
- AG Grid 双边期权链和 50ms 批量实时更新；
- IV Skew、OPRA Tape、垂直价差；
- BrokerAdapter 状态/预览；
- 数据来源、时效、完整性和 entitlement 显示。

旧 Vite UI 已删除。

OpenTerminal 可通过可选 `EQO_RESEARCH_PUBLIC_ORIGIN` 在原生 Sidebar 和 Command Palette 暴露 OpenBB Research 外链。它只接受纯 HTTPS origin（本地开发可用精确 loopback HTTP），hostname 必须不同于 `EQO_PUBLIC_ORIGIN`；链接在新标签打开，不共享 OpenTerminal OIDC 会话或凭据。未设置或非法时入口隐藏，主终端不依赖 OpenBB 服务启动。

主终端与 OpenBB 浏览器都只通过各自的 Next BFF 访问受保护 API。Next 使用固定 OIDC issuer 的 PKCE/state 会话，把 allowlist role 映射为短时委托；Gateway 校验 issuer、audience、kid、签名、有效期和 scope。OpenBB 使用独立 hostname 与 research-mode Next BFF；不同端口不足以隔离 host-only cookies，`EQO_TERMINAL_PUBLIC_ORIGIN` 缺失或与 research hostname 相同时 readiness 拒绝启动。Research BFF 只持有独立 research signer，验证其 OIDC 用户 session 与 `market:read` role 后签发最长 60 秒的 `market:read` 子 token。`/api/research/auth-check` 供 ingress 内部 `auth_request` 检查会话和角色，返回 204/401/403 且不签 token；公网 ingress 必须隐藏该路径。Research BFF/Lite 不配置终端 Gateway signer、Node API key 或 Alpaca market keys；只有 Rust Gateway 持有行情凭据。关闭可选 Research 服务不影响 OpenTerminal、Gateway 或 Node research 主服务。客户端身份头和静态 `EQO_ACCESS_TOKEN` 不构成认证。

## MDP 归档只读接口

只读路径为 `/api/eqo/market-data/datasets/{dataset_id}/bars?namespace=diagnostic&symbol=QQQ`。终端签发者固定为 `iss=eqoboard-openterminal` / `kid=mdp-terminal`，research 签发者固定为 `iss=openterminal-research` / `kid=mdp-research`；两者共用 audience `lqepoch-market-data`，但分别使用 `MDP_TERMINAL_JWT_SECRET` 与 `MDP_RESEARCH_JWT_SECRET`，并与 Gateway/NextAuth key 不同。

BFF 只接受最多 390 行、4 MiB 的 `lqepoch.us_equity_trade_bar_1m.v1` 响应，校验 schema fingerprint `5e761a91d880e0002aeafe6dc2083b7c8a0ff2ba486d5d93582fbb4479146cb0`、逐行来源和数值/时间语义。当前接口不含 CompletionV2，故 BFF 只放行 `diagnostic` 并在任何 MDP 请求前拒绝 `curated`。`synthetic`、`unknown`、缺失的 entitlement 或 NBBO 状态不会被改写成“行情已连接”。

已校验的 diagnostic minute bars 可在原生 `ChartWidget` 中按 dataset ID 加载；图表不实现第二套 BFF 校验。UI 仅将 bounded finite decimal projection 传给 Lightweight Charts，同时保留原十进制字符串作为 tooltip；来源切换即清除旧图表 series。展示始终标为 diagnostic/NOT LIVE，附来源、completion 和 promotion unavailable 状态，数值不得进入交易、合约身份或精确金融计算。

## 注册预测只读视图

主终端 Workspace 的注册预测 widget 和隔离 research hostname 都只调用同源 `/api/eqo/research/predictions/{run_id}` BFF。可信 OIDC role `eqoboard-private-research-reader` 独立授予 `research:private-read`；market role、通用 `research:read` 不可替代。两种运行模式各持一把 Quant 专用 key，分别签发 `eqoboard-openterminal` / `quant-terminal` 或 `openterminal-research` / `quant-research`，audience 为 `lqepoch-quant-research`，scope 精确为 `research:private-read`，期限最多 60 秒；这些 key 与身份、Gateway、MDP 及另一运行模式分离。

BFF 固定访问 `EQO_QUANT_RESEARCH_URL` 的 HTTPS、loopback 或私有 `quant-research` origin，不跟随 redirect、不接受任意 path/query/body，并校验 Quant response、assessment、SHA-256 与受限的公开 ProtoJSON。若 Quant response 带 `factor_feature`，BFF 只接受其精确摘要字段、已知 qualification/hash 状态及 `1..390` 行边界（与 Quant 注册读取器的 FactorIR 行数约束一致），校验后从浏览器 response 剥离该摘要；不接收 feature rows 或 private artifact。浏览器不接收 private envelope/artifact。LOCAL_REGISTERED_ROOT 只表明本地 registry 读取；source completeness、finite receipt 与 PIT 可继续为 UNKNOWN，promotion 始终 false。未部署/未配置 Quant 时界面显示不可用，不显示合成的 available 预测。

## Trading Engine 离线预览

原生 Workspace 的 `Engine Offline Preview` widget 使用两个同源 GET BFF 路由：`/api/eqo/engine/status` 与 `/api/eqo/engine/preview`。唯一 OIDC 授权角色为 `eqoboard-engine-offline-reader`，只映射 `engine:offline-read`；market、workspace、private-research 角色都不继承该 scope。终端使用独立 `ENGINE_TERMINAL_JWT_SECRET`，固定 `iss=eqoboard-openterminal`、`kid=engine-terminal`、`aud=lqepoch-trading-engine`、字符串 scope `engine:offline-read`、最多 60 秒。Research runtime 拒绝 Engine URL/key，且没有这些路由。

BFF 只允许固定的 `http://127.0.0.1:<port>` origin、固定 GET 路径、无 query/body、禁止 redirect、16 KiB 响应上限与 3 秒 deadline。完整 ProtoJSON 文本由 pinned `@lqepoch/trading-core-contracts` strict parser 校验，随后 BFF 序列化解析得到的 generated message，向浏览器返回一致的 camelCase/`$typeName` shape 和显式默认值；浏览器仅 type-import Core DTO，不运行 Node-only parser，也不复制领域校验。Engine 服务继续只绑定 loopback，因此 BFF 与 Engine 必须共享 host/network namespace。仓库 Compose 不启动 Engine；标准分离容器默认不满足此条件，故 URL/key 留空即明确 unavailable。

UI 只显示 synthetic/offline/source unknown、best-effort non-transactional 与有界 UNKNOWN 计数；两次读取不是原子快照或 reconciliation proof。任何状态都不表示账户或市场数据加载、execution readiness、交易权限或 promotion qualification。

## Rust 数据接口

共享 Rust 市场契约由固定 revision 的 `trading-core/crates/market-contracts` 持有。EqoBoard `crates/domain` 是旧 JSON DTO 的兼容 facade，保持现有 `eqo_domain::*` 消费者路径和 JSON 形状；新版本化 wire DTO 应直接复用 core 类型，不在本仓库复制。旧快照、bar 和事件中的 `f64` 是兼容投影，不保证精确十进制表示，不能作为新归档或执行合同。

所有受保护 Gateway 路由都要求可验证委托主体；`/healthz` 仅表示进程存活，`/readyz` 表示身份 keyring 可用。行情配置和 SIP/OPRA 授权另行判断，身份 readiness 不等于市场数据 ready。

- `GET /api/v1/status`
- `GET /api/v1/stocks/snapshots`
- `GET /api/v1/stocks/bars`
- `GET /api/v1/options/chain`
- `POST /api/v1/subscriptions/stocks`：活动股票/Watchlist 租约，和启动基础标的求并集。
- `POST /api/v1/subscriptions/options`：带正数 `generation` 的 OPRA 合约租约；HTTP 成功只表示 Gateway 接受租约，不代表上游已订阅。
- `GET /api/v1/stream/sse`：50ms 批量的统一股票/期权浏览器事件总线。
- `POST /api/v1/orders/preview`
- `POST /api/v1/orders/submit`

OpenBB Gateway 接口为 `/widgets.json`、`/apps.json`、`/openbb/v1/stocks`、`/openbb/v1/bars`、`/openbb/v1/options`。三类数据路由返回 Workspace table 使用的 flat row arrays，每行包含 `source` / `source_mode` / `source_label`、实际请求 `feed`、市场字段的 `market_as_of`、页数及 `has_more` / `truncated`。股票 row 另含请求覆盖与 snapshot/price/time completeness；bars 的 `market_as_of` 等于 bar 时间；期权 quote、trade、model 时间分离，没有专用模型时间时 `model_as_of` 保持 null。只有使用内置 `https://data.alpaca.markets` 时才声明 Alpaca；任意 `EQO_MARKET_DATA_BASE_URL` 覆盖均显示来源 unknown。

Gateway 有界消费 bars/options continuation token；缺失/null 表示终止，非空字符串表示续页，其他值使请求失败。无法解析的 OCC 符号、到期日与请求不一致及错误 OHLCV 行也会使请求失败，不静默丢弃或填零。页预算耗尽且仍有后续页但没有行情行时返回带来源和分页状态的 502；完整空结果仍返回 `200 []`，不追加占位行。OpenBB 普通 table 的 `refetchInterval` 只是 HTTP polling，不构成 Live Grid。

隔离 research BFF 对外提供 `/api/openbb/widgets.json`、`/api/openbb/apps.json` 及 `/api/openbb/openbb/v1/{stocks,bars,options}`。重复的 `openbb` path segment 来自 pinned Workspace `createURLString(endpoint, backendUrl)` 规则：custom source URL 是 `/api/openbb`，manifest endpoint 保持 `openbb/v1/...`。BFF 只映射这三条只读路径，要求隔离 hostname 上的 OIDC/NextAuth session 和 market-reader role，再使用 research signer 签发最长 60 秒、`kid=research`、`iss=openterminal-research`、`aud=eqoboard-gateway`、单一 `market:read` scope 的 token。manifest metadata 不授予行情访问能力；source、feed、as-of 和 truncation 来自 Gateway。

Research BFF 不配置主终端 Gateway signer、Node API key 或 Alpaca key/secret。Research BFF Playwright suite 覆盖生产 Next 与 mock OIDC/Gateway 的 API 组件边界；独立 OpenBB Playwright suite 才启动固定 Lite、真实 Rust Gateway 和受控 SIP/OPRA 协议 mock。attempt-22 无 skip 默认 Compose build/up、native Lite 三 Widget、停服独立性、Gateway offline/restart 与错误镜像恢复矩阵已通过。测试 mock 的 Gateway 行 `source=unknown`，不作为真实 Alpaca 行情来源或 entitlement 证明。

## 数据原则

SIP/OPRA 是硬约束。关键行情不允许用 Yahoo、IEX、indicative 等源替换后继续标记为 SIP/OPRA。快照、stream、bars 都保留上游时间，缺失字段保持 null。

## 演进

Foundation：OpenTerminal + Rust + AG Grid + OpenBB connector。

当前基础版只开放离线订单预览，Paper 与 Live 提交固定关闭。Paper MVP 还需三券商持久订单状态机、一次性 preview/outbox、账户身份、撤改单、持仓、成交、对账与恢复后另行验收。

Gateway preview 记录绑定验证后的 `(idp_iss, sub)`，相同 `sub` 但不同 issuer 不共享或消费 preview。当前 preview 仍是进程内一次性记录，不是持久 ledger。submit 的错误使用 `state/retryable/recovery_required/detail` 契约；上游结果不确定时返回 `UNKNOWN` 并保留原 `client_order_id`，不能引导换 ID 重下。status 中的 `adapter_endpoints_configured` 只描述 endpoint 配置；`broker_capabilities` 对 Alpaca、IBKR、Schwab 的 Paper 与 Live 均明确 disabled，Schwab 不映射为真实券商 Paper。

Production：OIDC/RBAC、持久事件存储、OpenTelemetry/SLO、WORM 审计、行情授权、限额/Kill Switch、灰度和灾备。

## 实时流治理

OpenTerminal 由单一 `MarketStreamProvider` 建立 SSE。所有 Widget 从共享 Zustand market store 消费事件；Option Chain 继续使用 AG Grid `applyTransactionAsync`，由 AG Grid 自身约 50ms 合并事务。Watchlist/Quote 不进行 1 秒 REST 轮询，15 秒快照只承担校准和日线字段补全。

股票和期权订阅都使用 90 秒租约，30 秒续租。浏览器关闭或 Widget 删除后主动释放，异常退出最多在 TTL 后回收。Rust 对多个浏览器/Widget 求订阅并集，只维持每个 feed 的共享上游连接。options 使用固定版本 Broker `MarketDataPort` 的单一只读 OPRA session；Gateway 复用 Broker 解码器和有序 control lane，不自建 WebSocket 或 ACK 状态机。options 租约需带正数 `generation`；旧代次拒绝，等代次只接受相同 symbol set。最大合约数取配置值和 Broker 的 32 个 quote/trade channel entries 双订阅上限（16 个合约）中的较小值，超限直接拒绝、不截断。并集变化时 Gateway 先取消并在 5 秒内排空旧 session，再开始新 session；超时会 poison supervisor 并停止，避免连接重叠。

Broker 完整 subscription ACK 可将对应 OPRA quote/trade channels 标为 `confirmed` 并完成该订阅请求的 coverage；它不代表认证成功、OPRA entitlement、来源真实性或新鲜行情。当前 Gateway 对 options 的 auth、source mode/label 和 source entitlement 均保持 `unknown`，`market_data_ready` 继续固定为 false。股票 SIP 仍走既有 `eqo-alpaca-data` stream adapter，没有接入 typed Broker ACK，故 confirmed 保持空、event time 不从 Gateway receive time推导。当前 Broker raw-frame record 在 Gateway 侧不做持久化；不能称为 durable raw capture。真实 provider、账户授权、OPRA/SIP 行情与 durable pre-decode sink 本阶段均未验证。
