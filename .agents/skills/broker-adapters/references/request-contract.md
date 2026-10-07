# 交易执行协议
版本 1：POST /v1/orders，header X-Idempotency-Key、可选 Bearer。
body 包含 schema_version=1、client_order_id、broker、environment=paper、intent。
BrokerAdapter 负责输入校验及执行服务路由；Rust 执行服务负责账号级认证、买卖能力、保证金、合约规格、净价与原子多腿执行。
请求 Accepted 不等于 Filled。超时必须凭 client_order_id 查证状态，禁止自动重试。
详情见 docs/ADAPTER_CONTRACT.md。
