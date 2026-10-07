# 网关 Agent
负责 HTTP/WS、权限校验、消息扇出、订阅租约、审计与启动配置。loopback 是默认监听；non-loopback 必须配置独立且可验证的 `EQO_GATEWAY_JWT_SECRET` 与 `EQO_RESEARCH_JWT_SECRET`，Gateway 按受信签名、固定 issuer/audience、`idp_iss` + `sub` 和 allowlist scope 验证主体，不能信任身份头或已退役的静态 `EQO_ACCESS_TOKEN`。WS ticket 仍限时且一次性；不在日志记录凭据；同步失败不盲重试。主要依据 .agents/skills/gateway-operations/SKILL.md。新增 API 同时更新 docs/ARCHITECTURE.md 和对应 Web Types。
