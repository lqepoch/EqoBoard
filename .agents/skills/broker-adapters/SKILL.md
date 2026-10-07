---
name: broker-adapters
description: 按统一订单契约对接 Alpaca、IBKR、Schwab 的独立 Rust 服务，包括两腿原子性、幂等、审计与恢复。
---
# BrokerAdapter Skill

适用范围：crates/execution/**、docs/ADAPTER_CONTRACT.md、各执行服务接口。
输入是后端预览锁定 OrderIntent；输出是 Accepted/Rejected/Unknown，成交确认需独立查询。
当前发布版的 effective execution 固定为 `disabled`，即使请求配置 `paper` 也只能做只读和离线 risk preview；任何券商都不能据此标记为真实 Paper。`schwab` 能力在当前版明确 disabled，Live 始终拒绝。只有一次性 preview 与订单/outbox 持久状态、账户身份/能力、恢复和对账验收完毕后，才可单独评审真实 Paper 开关。
每次改动检查：OCC 标准 root 与 adjusted 合约边界、整数 strike/金额、到期日可控时钟、同标的同到期日同权利类型、Call/Put方向推导出的 Debit/Credit、买卖腿相反、价差宽度、100 股标准乘数、未知非标准deliverable拒绝、series-specific tick来源、fee reserve/毛损边界、buying power、原子委托、超时不盲重试、client_order_id、券商回报二次风控。
垂直价差不得相信客户端 `net_effect`：Call 买低卖高/Put 买高卖低才是Debit，反方向是Credit；冲突输入拒绝。价格必须满足执行层整数精度边界，策略风险用 checked integer 运算。最大毛损需明确是否计入券商/交易所/行权费用；没有可信 fee schedule 时不得标成all-in损失。
标准 option multiplier 的来源与 adjusted symbol 规则见 `docs/ORDER_RISK.md` 和 `references/request-contract.md`。符号解析不是账户/合约主数据；真实 Paper 适配开放前必须确认 contract multiplier、deliverable、series tick 与账户能力。
必须新增不涉及券商真实 Key 的 mock HTTP 测试，确保拒绝下单/未知状态完整覆盖。
跨模块 API 修改需同步 references/request-contract.md。
