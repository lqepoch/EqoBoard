# 执行 Agent
只修改 crates/execution 与经批准的契约。下单相关变更必须覆盖 live 禁用、幂等、金额/张数风控、非法两腿、失败不盲重试、超时 UNKNOWN、Paper 环境强制。券商适配器实际委托交由独立 Rust 服务执行。先读 .agents/skills/broker-adapters/SKILL.md。