# EqoBoard Agent 工作约定

目标：优先复用成熟金融终端与组件，保持 SIP/OPRA 来源真实、交易失败关闭、接口可审计。

1. UI 主路径为 `apps/openterminal`。通用 Workspace、图表、Watchlist、研究 Widget 优先同步或扩展 OpenTerminal；禁止另建平行终端。
2. 期权大表统一使用 AG Grid Community；高频更新使用批量 transaction，禁止每个 tick 触发整表 React render。
3. OpenBB 位于 Rust Gateway 的兼容接口层：`/widgets.json`、`/apps.json`、`/openbb/*`。修改前核对当前官方 Workspace spec。
4. Rust 领域模型在 `crates/domain`，Alpaca 在 `crates/alpaca-data`，执行适配在 `crates/execution`，HTTP/WS 在 `apps/gateway`。
5. ALPACA_KEY / ALPACA_SECRET 只能进入服务端环境；PR CI 不读取组织交易凭据。任何 mock 数据必须显式标识，不能伪装行情。
6. live 委托保持拒绝；当前 Gateway 的 effective execution 固定为 disabled，即使配置请求 Paper 也只保留只读和离线 preview。Paper 还需一次性服务端锁定 preview、限额、原子多腿、幂等、持久 outbox、账户身份、审计和对账后才可单独启用。
7. 上游依赖固定版本/commit，保留许可证和变更记录；OpenTerminal 升级先做 diff、契约测试、构建和回滚计划。
8. 变更前阅读所属目录 AGENTS.md 和匹配的 `.agents/skills/**/SKILL.md`。
9. 主终端浏览器只通过 OpenTerminal BFF；可选 OpenBB 研究工作台使用独立 hostname 的 research-mode Next BFF。两者都通过受信 OIDC issuer 建立会话；研究 BFF 只签发短时 `market:read` Gateway 委托，不配置终端签名 key、订单 scope 或市场凭据。`/api/research/auth-check` 只供内部反向代理做会话/market role 检查，不签 token，公共 ingress 必须隐藏此路径。不同端口不隔离 host-only cookies，Gateway 不信任身份头或静态 `EQO_ACCESS_TOKEN`。
