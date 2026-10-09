---
name: gateway-operations
description: 维护 Rust Axum 网关鉴权、SIP/OPRA 订阅租约、WebSocket 扇出、可观测性与运行故障恢复。
---
# Gateway Operations Skill
路径：apps/gateway/**。
要求：loopback 默认；non-loopback 仅在 `EQO_GATEWAY_JWT_SECRET` 与 `EQO_RESEARCH_JWT_SECRET` 都可验证、彼此独立时启动。受保护请求必须携带由受信 BFF (`kid=bff`, 固定 issuer/audience) 或 research (`kid=research`, 仅 `market:read`) 签发的短时委托 JWT；身份由验签后的 `idp_iss` + `sub` 标识，action 由 allowlist scope 决定。禁止信任客户端身份头；静态 `EQO_ACCESS_TOKEN` 已退役，不能作为 Gateway 认证或启动条件。WS ticket 15秒有效且单次消费；禁止浏览器直接连接 Alpaca 带密钥端点；对 WS 慢客户端发送 `resync_required`。
行情出错保留 HTTP 上游分类；不得降级伪造来源。

历史归档读取属于独立 `market-data-platform` 服务，不属于 Gateway 行情采集/实时状态。浏览器只能通过 OpenTerminal 同源 BFF 的 `/api/eqo/market-data/datasets/{dataset_id}/bars` 读取；BFF 使用 audience=`lqepoch-market-data`、issuer/kid 按终端和 research hostname 固定映射的独立 MDP key，只签精确 `market:read` 且最长 60 秒。MDP key 不得与 NextAuth/Gateway key 共用，也不得跨 hostname 注入。现有 V1 bars 没有 CompletionV2 证据，BFF 只允许 `diagnostic`，拒绝 `curated`；`unknown` / `synthetic` provenance 不能显示为 SIP/OPRA 已连接或实时订阅确认。

共享 wire DTO 由固定版本的 `trading-core/market-contracts` 持有；EqoBoard `eqo-domain` 只重导出旧 JSON DTO 以保持现有消费者兼容。新版本化接口直接复用 core 类型和 golden fixtures，不在 Gateway 重复定义。旧 `f64` 字段只是兼容投影，不是精确行情合同。
订单前审计失败禁止发送；订单后审计失败高优先级错误日志。
测试：loopback 下缺身份key时进程可保留 liveness 但受保护 API/readiness fail closed；non-loopback 缺 key 或共用 BFF/research key 时拒绝启动；无效/过期 token、伪造身份头和错误 scope 在任何下游调用前拒绝。订单 preview 锁定 issuer + subject，跨主体确认拒绝；Paper submit 在持久订单/outbox、账户身份和真实适配器能力验收前保持 blocked、下游调用为零。另测非法订阅/超额订阅、异步多 tab leases 共享和断流恢复。

- 股票与期权订阅都使用共享 lease union；新增 Widget 不得新建 Alpaca 上游连接。
- OPRA options 使用固定版本 Broker `MarketDataPort` 的单 session 与有序 ACK/control lane。不要复制 WebSocket/MessagePack 解码或订阅状态机；ACK 精确确认 quote/trade channel coverage，但不证明 auth、entitlement、真实来源或 `market_data_ready`。options 请求须带正数 generation，过期/冲突代次不能确认当前租约；最大合约数不得超过配置值与 Broker 32 个 channel entries（双 channel 时最多 16 个）的较小值，超限拒绝，不静默截断。
- options 并集变化必须取消并有界排空旧 Broker session 后才创建新 session；排空超时 poison supervisor 并停止，不得建立重叠连接。当前 Broker raw-frame lane 在 Gateway 中不是 durable archive；除非实际接入并验收持久 sink，不得宣称原始帧已落盘。
- SSE/WS 新连接在注册 receiver 时回放最近的 stocks/options 状态；缓存上限固定为两个 feed，状态快照与发布序号串行化。慢客户端的 `resync_required` 复用 feed 当前 epoch，以触发现有 store 清除旧 live 值。
- 股票流仍走既有 adapter，尚未接入 typed Broker ACK；SIP auth、ACK coverage、source 和 entitlement 必须保持 unknown/未确认，不得从 HTTP lease 或 feed 名推导。
- 浏览器默认只维持一个 SSE；若引入新实时 Widget，优先订阅共享 market store。
