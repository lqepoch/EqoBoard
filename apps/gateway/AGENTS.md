# 网关 Agent
负责 HTTP/WS、权限校验、消息扇出、订阅租约、审计与启动配置。严守：外网无 token 必须拒绝启动；WS ticket 一次性；不在日志记录凭据；同步失败不盲重试。主要依据 .agents/skills/gateway-operations/SKILL.md。新增 API 同时更新 docs/ARCHITECTURE.md 和对应 Web Types。