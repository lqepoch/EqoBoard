---
name: gateway-operations
description: 维护 Rust Axum 网关鉴权、SIP/OPRA 订阅租约、WebSocket 扇出、可观测性与运行故障恢复。
---
# Gateway Operations Skill
路径：apps/gateway/**。
要求：loopback 默认；公网监听无 EQO_ACCESS_TOKEN 禁止启动；WS ticket 15秒有效且单次消费；禁止浏览器直接连接 Alpaca 带密钥端点；对 WS 慢客户端发送 resync_required。
行情出错保留 HTTP 上游分类；不得降级伪造来源。
订单前审计失败禁止发送；订单后审计失败高优先级错误日志。
测试：无凭据可启动并返回 503；非法订阅/超额订阅拒绝；异步多 tab leases 共享；断流恢复。
