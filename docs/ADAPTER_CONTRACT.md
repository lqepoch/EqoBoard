# 交易服务适配器契约 v1

EqoBoard **不存放券商 API 密钥**。交易服务未来独立运行，使用 Rust 实现 Alpaca / IBKR Gateway / Schwab 执行、订单回报、恢复和对账。本版本只提供接口契约与本地离线风险预览；Gateway effective execution 固定为 `disabled`，不向 `EQO_ADAPTER_<BROKER>_URL` 配置的服务 POST `/v1/orders`。配置了 adapter endpoint 只表示地址存在，不证明它是真实券商 Paper 能力。Alpaca、IBKR、Schwab 的 Paper 与所有 Live capability 当前均为 disabled；Schwab 不会被包装成券商 Paper 或未标记的本地 simulation。

安全约定：

- 当前 Gateway 对 `EQO_EXECUTION_MODE=disabled|paper|live` 的有效执行都保持 disabled；Paper submit 返回 typed `blocked` 并且 adapter 调用数为零，Live 始终拒绝。配置值只用于报告 requested mode，不能打开执行。
- 外部 HTTP 只允许 loopback URL；其他地址需 HTTPS。反向代理或 mTLS 由部署环境设置。
- 请求头 Content-Type: application/json、Authorization: Bearer <broker-specific token>（如配置）、X-Idempotency-Key: <UUID>。
- 执行服务必须做**第二次验证**：Paper 环境、权限、净价、两腿一揽子原子性、最大风险敞口、buying power、市场状态、重复单、账号绑定、撤单超时与异步重对账。
- 绝对禁止把垂直价差拆成两笔无保护的独立单腿作为“成功执行”。
- 服务端返回订单接受状态 ≠ 成交；超时属于 `UNKNOWN`，保留原 `client_order_id` 和恢复要求，必须先按 ID 查询实际状态，禁止换 ID 重下。

即使将来单独启用 Paper，Gateway preview 也必须绑定由有效委托 JWT 验证的身份 `(idp_iss, sub)`；不同 issuer 下即使 `sub` 相同也不得互相确认或消费 preview。preview 目前是 Gateway 进程内的一次性记录，不是持久订单账本，所以这一身份绑定不构成提交门闩的完成证据。

以下请求/响应仅定义未来 adapter 的内部契约，不是当前可调用的委托能力；在持久状态、账户身份和能力门闩完成前，Gateway 不会发送该请求。

```json
{
  "schema_version": 1,
  "client_order_id": "uuid",
  "broker": "ibkr",
  "environment": "paper",
  "intent": {
    "broker": "ibkr",
    "kind": "vertical",
    "symbol": null,
    "quantity": 1,
    "limit_price": 0.92,
    "net_effect": "debit",
    "legs": [
      {"symbol":"QQQ261007P00600000","side":"buy"},
      {"symbol":"QQQ261007P00599000","side":"sell"}
    ]
  }
}
```

返回 JSON 示例：`{"client_order_id":"uuid","status":"accepted","broker_order_id":"...","as_of":"RFC3339"}`。只有 `client_order_id` 与请求一致且 `status` 恰为 `accepted` 才是成功 ACK；匹配 ID 的 `rejected` 是明确业务拒绝。ID 不匹配、字段缺失、未知状态或其他响应歧义都归为 `UNKNOWN`，保留原 ID 供恢复。

只有 HTTP 422 明确表示该订单被业务规则拒绝。HTTP 408、409、429、其他非成功状态、响应解析失败和传输超时都可能发生在订单已被接收之后，统一作为 `UNKNOWN`；保留原 `client_order_id`，先按该 ID 查询和恢复，禁止换 ID 重下。日志保留 broker、client_order_id、状态、时间，不记录 token。

成交、改单、撤单、持仓、对账、账户信息在后续版本通过独立只读查询 adapter API 扩展，所有交互由版本化 schema 管理。
