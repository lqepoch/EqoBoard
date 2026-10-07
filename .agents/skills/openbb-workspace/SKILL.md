---
name: openbb-workspace
description: 维护 EqoBoard 的 OpenBB Workspace custom backend、widgets.json、apps.json、认证和兼容性。
---
# OpenBB Workspace Skill

使用当前官方 Workspace 文档作为 schema 来源。入口为 Rust Gateway。

- `/widgets.json` 与 `/apps.json` 必须返回规范 JSON。
- Widget endpoint 返回 flat JSON array；AgGrid 配置使用官方 `columnsDefs` 字段。
- OpenBB 的 upstream Lite 使用独立 research hostname 和隔离的 Next research BFF。`EQO_TERMINAL_PUBLIC_ORIGIN` 必须指向主终端 origin 且 hostname 不同；仅使用不同端口仍会共享 host-only cookie，research readiness 会拒绝这种配置。用户先通过现有 OIDC/NextAuth session 登录，服务端再用独立 research signer 签发最长 60 秒、`kid=research`、`iss=openterminal-research`、`aud=eqoboard-gateway`、单一 `market:read` scope 的委托 JWT。research runtime 不配置终端 Gateway signer、Node API key 或市场密钥，且拒绝非空 `ALPACA_KEY`/`ALPACA_SECRET`；市场凭据只进入 Rust Gateway。静态 `EQO_ACCESS_TOKEN` 已退役，不能为 OpenBB 放宽 Gateway 验证。
- OpenBB custom source URL 为同源 `/api/openbb`。pinned upstream 的 endpoint 字符串 `openbb/v1/stocks` 等会拼接成 `/api/openbb/openbb/v1/...`；BFF 必须只映射这三条只读数据路径，并保留 Gateway 的错误、feed、时间戳和 truncated 元数据。不得从 manifest 的描述文字推断实际 source。
- `/api/research/auth-check` 是反向代理内部的 `auth_request` 端点：market-reader 返回空 204，匿名返回 JSON 401，缺少 market role 返回 JSON 403；它只检查 OIDC 会话，不签发 Gateway token。公网 ingress 必须仅在内部子请求位置使用它，不能把该路由作为普通浏览器/API 路径发布。
- Next middleware 不匹配 bounded JSON 写接口，避免适配器预先克隆未完成请求流导致 route 层大小/超时门禁失效。每个被排除的 handler 必须在读取 body 前拒绝 research mode，且 research 测试覆盖订单、订阅、portfolio 和 AI 写入口。
- `npm run test:e2e:research --workspace web` 会构建 production Next 并用 OIDC/Gateway mock 验证隔离 BFF/API，包括市场 role、401/403、路径 allowlist、请求参数、委托期限、响应透传和 truncated。它是组件测试，不会运行 OpenBB Lite；不得把它标记为真实 Lite 浏览器 E2E 或 “OpenBB Web integrated”。
- SIP/OPRA endpoint 必须显式检查 feed；失败返回错误，不切换数据源。
- OpenBB 处于 OpenBQ/FINOS 治理迁移阶段，接口兼容层保持薄，业务模型不得绑定 Workspace 内部实现。
- 新增 live_grid 前验证 WebSocket 的认证、Origin 和市场数据再分发边界。
