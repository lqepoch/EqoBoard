# 交易执行协议
版本 1：POST /v1/orders，header X-Idempotency-Key、可选 Bearer。
body 包含 schema_version=1、client_order_id、broker、environment=paper、intent。
BrokerAdapter 负责输入校验及执行服务路由；Rust 执行服务负责账号级认证、买卖能力、保证金、合约规格、净价与原子多腿执行。
请求 Accepted 不等于 Filled。超时必须凭 client_order_id 查证状态，禁止自动重试。
详情见 docs/ADAPTER_CONTRACT.md。

## v1 金额与垂直价差校验

- `intent.limit_price` 仍是 JSON 数值以兼容现有 schema；当前执行预览只接收精确到整美分的有限正数，内部转换成整数金额再运算。次美分输入拒绝。
- 股票按股数处理。标准单腿期权仅允许买入开仓。垂直价差必须是同一标准 OCC underlying、到期日、权利类型的一买一卖组合；策略方向决定净效果：Call 买低/卖高和 Put 买高/卖低为 Debit，反方向为 Credit，客户端 `net_effect` 不一致时拒绝。
- 期权风险使用每张 100 股的标准 multiplier。符号含数字 adjusted root 时拒绝；当前请求没有可信合约主数据，真实 adapter 仍需核实 deliverable、multiplier、系列 tick 和账户能力。
- `estimated_max_loss` 代表以净限价计算的到期 payoff 毛损，不包含券商、交易所、监管、行权/指派或后续平仓费用。未接入可信费用表前，不得称为 all-in 风险金额。
- option 到期日必须晚于服务端校验日期。系列对应的 penny/nickel tick 由能查询合约元数据的 adapter 检查，执行 preview 的美分精度校验不等于 tick 合法性校验。

详见 [`docs/ORDER_RISK.md`](../../../../docs/ORDER_RISK.md) 和 [OCC标准合约与调整规则](https://www.theocc.com/clearance-and-settlement/clearing/equity-options-product-specifications)、[OCC OSI adjusted root说明](https://infomemo.theocc.com/infomemos?number=26853)。
