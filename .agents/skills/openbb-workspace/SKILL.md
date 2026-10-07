---
name: openbb-workspace
description: 维护 EqoBoard 的 OpenBB Workspace custom backend、widgets.json、apps.json、认证和兼容性。
---
# OpenBB Workspace Skill

使用当前官方 Workspace 文档作为 schema 来源。入口为 Rust Gateway。

- `/widgets.json` 与 `/apps.json` 必须返回规范 JSON。
- Widget endpoint 返回 flat JSON array；AgGrid 配置使用官方 `columnsDefs` 字段。
- 每条 OpenBB market row 必须返回真实来源身份、feed、该市场值自己的 `market_as_of`、分页/截断和 completeness 字段。只在固定 Alpaca API 地址可确认时返回 `source_mode=alpaca`；任意自定义 `EQO_MARKET_DATA_BASE_URL` 保持 `unknown`。缺失的 quote/trade/model 时间保持 null，不得填 Gateway 请求时间。
- bars/options 的 provider `next_page_token` 必须按有界页数消费，并返回 `pages_fetched`、`has_more`、`truncated`。空结果保持空数组，不伪造表格行来携带状态。
- `refetchInterval` 代表普通 HTTP polling；它不构成 Live Grid 或 WebSocket 实时证据。只有实现并验证官方 `wsEndpoint` 协议、认证与来源边界后才能声明 Live Grid。
- 日期默认值必须使用 Workspace 支持的动态日期修饰符或留空，禁止在固定 manifest 中写入会过期的合约日期。
- Backend 连接必须通过 Authorization header 携带短时、受信 issuer/audience 与 `market:read` scope 约束的 Gateway 委托 JWT；静态 `EQO_ACCESS_TOKEN` 已退役，不能为 OpenBB 放宽 Gateway 验证。OpenBB Workspace 的 OIDC 登录到 Gateway 委托链路尚未完成真实联调，属于 #13 后续验收；在联调前不能宣称 OpenBB 可访问受保护市场数据。市场密钥不进入 Workspace。
- SIP/OPRA endpoint 必须显式检查 feed；失败返回错误，不切换数据源。
- OpenBB 处于 OpenBQ/FINOS 治理迁移阶段，接口兼容层保持薄，业务模型不得绑定 Workspace 内部实现。
- 新增 live_grid 前验证 WebSocket 的认证、Origin 和市场数据再分发边界。
