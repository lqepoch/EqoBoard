# OpenTerminal integration Agent

该目录源于 OpenTerminal MIT 上游。通用功能优先保留上游实现。

- 上游基线见 `docs/THIRD_PARTY.md`。
- 股票/期权价格、K线、Option Chain 只能通过 `web/lib/eqo-market.ts` → Rust Gateway。
- FRED/SEC/FINRA/新闻等补充研究 Provider 可沿用上游 server。
- EqoBoard 自有 widget 放在 `web/components/widgets`，优先复用当前依赖，避免再引入同类 UI 框架。
- Option Chain 固定 AG Grid Community；空 IV/Greeks 不转换成 0。
- 新交易 UI 只能调用服务端 `/api/eqo/orders/*`，浏览器不得接触券商/Alpaca密钥。
- 所有 `/api` BFF 路由（含通用代理、订单、订阅和 SSE）必须要求当前 OIDC 会话及 action scope；写请求校验同源 Origin 和 bounded JSON。角色只来自受信 OIDC claims allowlist，不能由浏览器/session update 提升。
- Next→Gateway 和 Next/Node→Gateway 使用不同受众及独立 HMAC key。Node 只能签 `market:read` 子 token；不能继承 BFF 的订单 key 或权限。缺少认证配置时 UI 显示不可用且下游调用次数为零。
- `EQO_ACCESS_TOKEN` 已废弃；Paper/Live 在当前发布版均保持关闭。Portfolio owner 由 issuer+subject 派生，旧 `local` 数据不可自动转移给登录用户。
- 同步上游必须保留 MIT LICENSE、固定 commit、diff 记录并运行全部构建。
