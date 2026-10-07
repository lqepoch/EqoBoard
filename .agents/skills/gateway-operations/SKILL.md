---
name: gateway-operations
description: 维护 Rust Axum 网关鉴权、SIP/OPRA 订阅租约、WebSocket 扇出、可观测性与运行故障恢复。
---
# Gateway Operations Skill
路径：apps/gateway/**。
要求：loopback 默认；non-loopback 仅在 `EQO_GATEWAY_JWT_SECRET` 与 `EQO_RESEARCH_JWT_SECRET` 都可验证、彼此独立时启动。受保护请求必须携带由受信 BFF (`kid=bff`, 固定 issuer/audience) 或 research (`kid=research`, 仅 `market:read`) 签发的短时委托 JWT；身份由验签后的 `idp_iss` + `sub` 标识，action 由 allowlist scope 决定。禁止信任客户端身份头；静态 `EQO_ACCESS_TOKEN` 已退役，不能作为 Gateway 认证或启动条件。WS ticket 15秒有效且单次消费；禁止浏览器直接连接 Alpaca 带密钥端点；对 WS 慢客户端发送 `resync_required`。
行情出错保留 HTTP 上游分类；不得降级伪造来源。
订单前审计失败禁止发送；订单后审计失败高优先级错误日志。
测试：loopback 下缺身份key时进程可保留 liveness 但受保护 API/readiness fail closed；non-loopback 缺 key 或共用 BFF/research key 时拒绝启动；无效/过期 token、伪造身份头和错误 scope 在任何下游调用前拒绝。订单 preview 锁定 issuer + subject，跨主体确认拒绝；Paper submit 在持久订单/outbox、账户身份和真实适配器能力验收前保持 blocked、下游调用为零。另测非法订阅/超额订阅、异步多 tab leases 共享和断流恢复。

- 股票与期权订阅都使用共享 lease union；新增 Widget 不得新建 Alpaca 上游连接。
- 浏览器默认只维持一个 SSE；若引入新实时 Widget，优先订阅共享 market store。
