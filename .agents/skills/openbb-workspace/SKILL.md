---
name: openbb-workspace
description: 维护 EqoBoard 的 OpenBB Workspace custom backend、widgets.json、apps.json、认证和兼容性。
---
# OpenBB Workspace Skill

使用当前官方 Workspace 文档作为 schema 来源。入口为 Rust Gateway。

- `/widgets.json` 与 `/apps.json` 必须返回规范 JSON。
- Widget endpoint 返回 flat JSON array；AgGrid 配置使用官方 `columnsDefs` 字段。
- Backend 连接必须通过 Authorization header 携带短时、受信 issuer/audience 与 `market:read` scope 约束的 Gateway 委托 JWT；静态 `EQO_ACCESS_TOKEN` 已退役，不能为 OpenBB 放宽 Gateway 验证。OpenBB Workspace 的 OIDC 登录到 Gateway 委托链路尚未完成真实联调，属于 #13 后续验收；在联调前不能宣称 OpenBB 可访问受保护市场数据。市场密钥不进入 Workspace。
- OpenTerminal 中的可选 OpenBB Research 导航读取服务端校验的 `EQO_RESEARCH_PUBLIC_ORIGIN`，仅在新标签打开独立 UI origin；它不传递 OpenTerminal OIDC session/token，也不证明 Workspace 到 Gateway 的认证链路已集成。
- SIP/OPRA endpoint 必须显式检查 feed；失败返回错误，不切换数据源。
- OpenBB 处于 OpenBQ/FINOS 治理迁移阶段，接口兼容层保持薄，业务模型不得绑定 Workspace 内部实现。
- 新增 live_grid 前验证 WebSocket 的认证、Origin 和市场数据再分发边界。
