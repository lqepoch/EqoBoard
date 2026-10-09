# OpenTerminal integration Agent

该目录源于 OpenTerminal MIT 上游。通用功能优先保留上游实现。

- 上游基线见 `docs/THIRD_PARTY.md`。
- 实时股票/期权价格、K线、Option Chain 走 `web/lib/eqo-market.ts` → Rust Gateway；离线归档分钟 bars 只读入口是 `/api/eqo/market-data/datasets/{dataset_id}/bars`，由同源 Next BFF 转发到独立 MDP HTTP API，不替代 Gateway 实时接口。
- Web/Node 只消费 Gateway 提供的可信来源/时间/状态字段，不推断 `feed=sip|opra` 就代表 Alpaca。OPRA Gateway 路径现在消费 Broker typed ACK 并发布 generation/epoch/coverage 状态，但 auth、entitlement 和 provider 来源仍为 unknown；legacy SIP/REST 数值缺少来源或事件时间时必须继续显示 unknown，legacy SIP stream 不得显示 LIVE。#3 的真实 provider/entitlement 验收未由 Web/Node 测试代替。
- FRED/SEC/FINRA/新闻等补充研究 Provider 可沿用上游 server。
- EqoBoard 自有 widget 放在 `web/components/widgets`，优先复用当前依赖，避免再引入同类 UI 框架。
- 可选 OpenBB Research 入口只扩展原生 Sidebar/Command Palette，使用服务端验证后的 `EQO_RESEARCH_PUBLIC_ORIGIN` 在新标签打开独立 origin；变量必须是 HTTPS 或精确 loopback HTTP 纯 origin，hostname 与 `EQO_PUBLIC_ORIGIN` 不同。缺省或非法配置隐藏入口且不影响终端；这只是外链，不共享 OIDC 会话、凭据或 Gateway 状态。
- Option Chain 固定 AG Grid Community；空 IV/Greeks 不转换成 0。
- 所有 U.S. 股票/ETF 的价格、涨跌、成交量、历史 bars、财报价格变动请求 `Alpaca SIP`；TradingView 只用于市场元数据和明确标注的研究字段。SIP 403/缺失时显示 unavailable，不回退到免费行情源；缺少可信来源字段的 legacy 数值需显示 source/as-of unknown。
- 期权 quote/trade 请求 `Alpaca OPRA`。IV/Greeks 是 Alpaca REST snapshot 的 vendor/model 字段，不是 OPRA 原生字段；没有独立模型时间就显示 `model as-of unknown`，不能继承 quote/trade 或 Gateway response 时间。
- Widget 将浏览器 SSE、上游认证、订阅 ACK、覆盖率和逐事件新鲜度分开显示。只有 Gateway ACK 能确认订阅；浏览器连接或 REST lease accepted 不能代表上游 ready/live。OPRA Gateway 路径会发布 typed ACK coverage，但 source/auth/entitlement 仍为 unknown；legacy SIP 仍无 typed ACK。缺失 event time 保持 unknown。
- OptionsWidget 不因实时租约裁剪 REST 返回行（上游 `truncated` 仍单独标记），只按 Gateway 返回的有效 coverage limit 申请去重后的有限实时租约，优先选择最接近 underlying 的合约；limit 缺失或无效时不申请实时租约。limit 仅作为当前 `gateway_instance_id` 的配置元数据：同一 Gateway 的浏览器 SSE 短暂断开可保留该 limit，但连接状态、ACK、实时值和 freshness 仍清空；收到新 Gateway 实例或同实例明确缺失/无效的 limit 后必须清除。有限租约不表示整条链已覆盖，也不改变 source/auth/entitlement 的 unknown 状态。
- UI 用共享时钟同时执行 Gateway `fresh_until` 与独立五秒客户端保护阈值，较早者生效；服务器期限不能延长客户端上限。事件时间晚于同一发布的 `received_at` 时保持 unknown。五秒是显示保护，不是 Gateway freshness policy。空闲 SSE 不得让旧 tick 永久保持 LIVE。
- 同一行情状态由 `web/store/market.ts` 持有；REST watermark 按 feed/symbol/event type 防旧响应与旧 tick，Gateway instance/epoch 变化或 resync 会清理旧 live 值。Options BFF 要求正的 JavaScript safe-integer generation 并转发到 Gateway；Gateway 拒绝旧代次和同代次冲突的 symbol set，接受 HTTP lease 不等于上游 ACK。股票订阅仍走旧接口，不具备同等 generation 保护；任何租约状态都不能替代 provider ACK 或证明来源/entitlement。
- 行情来源、as-of 与 coverage 定义见 [`docs/MARKET_SOURCES.md`](../../docs/MARKET_SOURCES.md)。
- 新交易 UI 只能调用服务端 `/api/eqo/orders/*`，浏览器不得接触券商/Alpaca密钥。
- 终端 `/api` BFF 路由（含通用代理、订单、订阅和 SSE）必须要求当前 OIDC 会话及 action scope；写请求校验同源 Origin 和 bounded JSON。角色只来自受信 OIDC claims allowlist，不能由浏览器/session update 提升。研究模式的 `/api/openbb/widgets.json`、`apps.json` 只返回非敏感 metadata；市场 endpoints 仍必须校验 `market:read`。
- Next middleware matcher 为保留 route handler 对原始请求流的大小/超时控制，会排除 `readBoundedJson` 写路由和 NextAuth body parser。每个被排除的 handler 必须在读取请求体前显式拒绝或精确 allowlist research mode；新增 body-reading route 时同步审计 matcher、research deny-by-default 和组件/E2E 测试。
- Next→Gateway 和 Next/Node→Gateway 使用不同受众及独立 HMAC key。Node 只能签 `market:read` 子 token；不能继承 BFF 的订单 key 或权限。缺少认证配置时 UI 显示不可用且下游调用次数为零。
- Next→MDP 使用与 Gateway/NextAuth 完全分离的短时 HMAC key、issuer、`kid` 与 audience；终端只持 `MDP_TERMINAL_JWT_SECRET`，research runtime 只持 `MDP_RESEARCH_JWT_SECRET`。仅允许精确 `market:read`，最长 60 秒；浏览器不得直连 MDP。
- 当前 MDP BFF 只接受 V1 `diagnostic` bars，并严格校验共享 schema 指纹、行来源、时间、精确十进制和完整性事实；V1 没有 CompletionV2 资格证据，因此 `curated` 一律在下游请求前拒绝。`synthetic` / `unknown` 必须原样保留，归档读取不能显示为行情已连接或订阅已确认。
- MDP 历史归档图只复用原生 `ChartWidget` 与 `/api/eqo/market-data/...` BFF；它不是 Gateway 实时流。图表数值是有界有限的显示投影，原十进制字符串保留在 tooltip，不能进入交易、身份或精确计算路径；切换来源时清除旧 series，并显示 diagnostic/source/completion 状态及 promotion unavailable。
- 注册预测 widget 只调用 `/api/eqo/research/predictions/{run_id}` 同源 BFF。唯一授权角色是受信 OIDC `eqoboard-private-research-reader`；不能从 `eqoboard-market-reader` 或 `research:read` 派生权限。终端与 research runtime 分别只持有 `QUANT_TERMINAL_JWT_SECRET` / `QUANT_RESEARCH_JWT_SECRET`，只签精确 `research:private-read`、audience `lqepoch-quant-research`、最长 60 秒 token；key 与 NextAuth、Gateway、MDP 及另一模式 key 分离。BFF 必须固定 `EQO_QUANT_RESEARCH_URL` origin、拒绝 redirect，并用 package-lock 固定的 `@lqepoch/trading-core-contracts` ProtoJSON 文本解析器校验投影，再返回给浏览器。浏览器只看到公开 ProtoJSON 投影和 UNKNOWN/diagnostic 证据，不读取或显示 private artifact/envelope。promotion 始终拒绝。
- Engine offline preview 只扩展当前 Workspace、Sidebar 和 `EngineOfflinePreviewWidget`，不新建终端或模拟行情组件。两个只读 BFF 路由 `/api/eqo/engine/status` 与 `/api/eqo/engine/preview` 都必须验证受信 OIDC `eqoboard-engine-offline-reader`，只签精确字符串 scope `engine:offline-read`，issuer/kid/audience 固定为 `eqoboard-openterminal` / `engine-terminal` / `lqepoch-trading-engine`，token 最长 60 秒。终端 key 为 `ENGINE_TERMINAL_JWT_SECRET`，Research runtime 必须缺少该 key 与 `EQO_ENGINE_URL`。Engine URL 只允许显式 `http://127.0.0.1:<port>`，因为 Engine 服务自身保持 loopback bind；BFF 与 Engine 必须共享网络命名空间。固定 GET 禁止 query/body/redirect，bounded response、deadline、no-store，并以 pinned Core parser 校验 raw ProtoJSON；BFF 随后返回同一个 Core generated message 的 camelCase/`$typeName` 形状和显式默认值，浏览器只 type-import Core DTO，不重复解析或验证领域契约。无配置返回 unavailable；所有结果保留 `synthetic_offline`、`source unknown`、best-effort non-transactional、execution/order mutation disabled；不得解释为真实账户、风险、市场、持久化完成或交易授权证据。
- OpenBB 使用独立 hostname 的 Next research-mode runtime：cookie 名称与 NextAuth secret 独立，`EQO_TERMINAL_PUBLIC_ORIGIN` 必须配置且 hostname 与研究 origin 不同，换端口不能隔离 host-only cookie；Gateway 委托最长 60 秒且只含 `market:read`。readiness 拒绝非空 `ALPACA_KEY`/`ALPACA_SECRET`，行情凭据只配置在 Rust Gateway。`/api/research/auth-check` 只验证 OIDC session 和 market role，不签 token，必须由反向代理内部调用且不能公开暴露。不得配置 `EQO_GATEWAY_JWT_SECRET` 或 `EQO_RESEARCH_API_KEY`，不得代理订单/账户/管理路由。不要与主终端 origin 共享会话或将研究服务端口直接发布。
- `npm run test:e2e:research --workspace web` 构建 production Next 并运行隔离 OIDC/Gateway mock。它只证明 BFF/API 组件行为，不启动 OpenBB Lite，也不证明 Rust Gateway、SIP/OPRA 或真实 Lite 浏览器集成；对应 profile、ingress 和 Lite E2E 必须单独验收。
- `EQO_ACCESS_TOKEN` 已废弃；Paper/Live 在当前发布版均保持关闭。Portfolio owner 由 issuer+subject 派生，旧 `local` 数据不可自动转移给登录用户。
- 同步上游必须保留 MIT LICENSE、固定 commit、diff 记录并运行全部构建。
