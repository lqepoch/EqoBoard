# 执行 Agent
只修改 crates/execution 与经批准的契约。下单相关变更必须覆盖 live 禁用、幂等、金额/张数风控、非法两腿、失败不盲重试、超时 UNKNOWN、Paper 环境强制。券商适配器实际委托交由独立 Rust 服务执行。先读 .agents/skills/broker-adapters/SKILL.md。

风控金额必须使用固定精度整数和 checked 运算，不得以客户端 `net_effect` 单独决定垂直价差方向。option 仅按已声明的标准 OCC/100股乘数范围计算，numeric adjusted roots、到期日边界和次美分限价 fail closed；缺少权威 multiplier/deliverable 或费用表时要明确风险边界，不得宣称 all-in 最大损失或真实券商 Paper 能力。测试优先调用 `validate_order_at` 注入校验日期，避免 expiry 回归依赖运行日。
