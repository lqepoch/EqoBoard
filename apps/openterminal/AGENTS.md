# OpenTerminal integration Agent

该目录源于 OpenTerminal MIT 上游。通用功能优先保留上游实现。

- 上游基线见 `docs/THIRD_PARTY.md`。
- 股票/期权价格、K线、Option Chain 只能通过 `web/lib/eqo-market.ts` → Rust Gateway。
- FRED/SEC/FINRA/新闻等补充研究 Provider 可沿用上游 server。
- EqoBoard 自有 widget 放在 `web/components/widgets`，优先复用当前依赖，避免再引入同类 UI 框架。
- Option Chain 固定 AG Grid Community；空 IV/Greeks 不转换成 0。
- 所有 U.S. 股票/ETF 的价格、涨跌、成交量、历史 bars、财报价格变动必须由 `Alpaca SIP` 提供；TradingView 只用于市场元数据和明确标注的研究字段。SIP 403/缺失时显示 unavailable，不回退到免费行情源。
- 期权 quote/trade 使用 `Alpaca OPRA`。IV/Greeks 是 Alpaca REST snapshot 的 vendor/model 字段，不是 OPRA 原生字段；没有独立模型时间就显示 `model as-of unknown`，不能继承 quote/trade 或 Gateway response 时间。
- Widget 将浏览器 SSE、上游认证、订阅 ACK、覆盖率和逐事件新鲜度分开显示。只有 Gateway ACK 能确认订阅；浏览器连接或 REST lease accepted 不能代表上游 ready/live。缺失 event time 保持 unknown。
- Gateway `fresh_until` 存在时 UI 用共享时钟按该期限使 freshness 过期；旧投影没有该字段时使用有文档的五秒客户端显示保护阈值，不能称作 Gateway freshness policy。空闲 SSE 不得让旧 tick 永久保持 LIVE。
- 同一行情状态由 `web/store/market.ts` 持有；REST watermark 按 feed/symbol/event type 防旧响应与旧 tick，epoch 变化/resync 会清理旧 live 值。订阅清理使用递增 generation tombstone。
- 行情来源、as-of 与 coverage 定义见 [`docs/MARKET_SOURCES.md`](../../docs/MARKET_SOURCES.md)。
- 新交易 UI 只能调用服务端 `/api/eqo/orders/*`，浏览器不得接触券商/Alpaca密钥。
- 所有 `/api` BFF 路由（含通用代理、订单、订阅和 SSE）必须要求当前 OIDC 会话及 action scope；写请求校验同源 Origin 和 bounded JSON。角色只来自受信 OIDC claims allowlist，不能由浏览器/session update 提升。
- Next→Gateway 和 Next/Node→Gateway 使用不同受众及独立 HMAC key。Node 只能签 `market:read` 子 token；不能继承 BFF 的订单 key 或权限。缺少认证配置时 UI 显示不可用且下游调用次数为零。
- `EQO_ACCESS_TOKEN` 已废弃；Paper/Live 在当前发布版均保持关闭。Portfolio owner 由 issuer+subject 派生，旧 `local` 数据不可自动转移给登录用户。
- 同步上游必须保留 MIT LICENSE、固定 commit、diff 记录并运行全部构建。
