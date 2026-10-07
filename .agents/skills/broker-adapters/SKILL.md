---
name: broker-adapters
description: 按统一订单契约对接 Alpaca、IBKR、Schwab 的独立 Rust 服务，包括两腿原子性、幂等、审计与恢复。
---
# BrokerAdapter Skill

适用范围：crates/execution/**、docs/ADAPTER_CONTRACT.md、各执行服务接口。
输入是后端预览锁定 OrderIntent；输出是 Accepted/Rejected/Unknown，成交确认需独立查询。
运行时默认 disabled，只可显式 paper，live 仍拒绝。
每次改动检查：OCC 标准、同标的同到期日同权利类型、买卖腿相反、价差宽度、100 乘数、buying power、原子委托、超时不盲重试、client_order_id、券商回报二次风控。
必须新增不涉及券商真实 Key 的 mock HTTP 测试，确保拒绝下单/未知状态完整覆盖。
跨模块 API 修改需同步 references/request-contract.md。
