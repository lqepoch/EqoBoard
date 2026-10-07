# 交易服务适配器契约 v1

EqoBoard **不存放券商 API 密钥**。交易服务独立运行，使用 Rust 实现 Alpaca / IBKR Gateway / Schwab 执行、订单回报、恢复和对账。网关向 EQO_ADAPTER_<BROKER>_URL 配置的服务 POST **/v1/orders**。

安全约定：

- 网关只在 EQO_EXECUTION_MODE=paper 时允许下单；live 模式显式拒绝；默认 disabled。
- 外部 HTTP 只允许 loopback URL；其他地址需 HTTPS。反向代理或 mTLS 由部署环境设置。
- 请求头 Content-Type: application/json、Authorization: Bearer <broker-specific token>（如配置）、X-Idempotency-Key: <UUID>。
- 执行服务必须做**第二次验证**：Paper 环境、权限、净价、两腿一揽子原子性、最大风险敞口、buying power、市场状态、重复单、账号绑定、撤单超时与异步重对账。
- 绝对禁止把垂直价差拆成两笔无保护的独立单腿作为“成功执行”。
- 服务端返回订单接受状态 ≠ 成交；超时属于 UNKNOWN，利用 client_order_id 查询实际状态，再决定补单/撤单。

\`\`\`json
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
\`\`\`

返回 JSON 示例：\`{"client_order_id":"uuid","status":"accepted","broker_order_id":"...","as_of":"RFC3339"}\`。

服务端可返回 HTTP 409 幂等冲突、422 交易拒绝、503 连接断开。网关透传合理业务状态，日志保留 broker、client_order_id、状态、时间，不记录 token。

成交、改单、撤单、持仓、对账、账户信息在后续版本通过独立只读查询 adapter API 扩展，所有交互由版本化 schema 管理。
