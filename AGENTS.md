# EqoBoard Agent 工作约定（所有子目录生效）

目标：工程可运行、数据源真实且可审计、交易默认失败关闭。用户偏好简体中文文档及 Issue，代码类型命名遵循 Rust/TypeScript 标准。

1. **每个变更**附范围、测试结果、数据来源、安全影响。任何 API / feed 变动先核验 Alpaca 官方文档（查阅日期）。
2. **不得**向 React、浏览器、本地存储或公共日志注入 ALPACA_KEY / ALPACA_SECRET；不得让 PR CI 读组织凭据。
3. **不得**把 mock 值伪装为实时行情；缺少 entitlement / 断流立即显示降级状态和采集时间。策略指标必须注明计算公式和适用假设。
4. **不得**自动启用 live 下单。实现券商交易时优先 Paper、幂等键、原子多腿、风控、审计、对账、未知状态恢复。
5. Rust 业务模型在 crates/domain，采集在 crates/alpaca-data，执行适配在 crates/execution，HTTP/WS 在 apps/gateway；React 页面在 apps/web。
6. 避免把券商 DTO 跨层直接传播；使用版本化规范接口，更新 schema 需测试。
7. AI 子 Agent 划分：行情、交易、前端、测试与运维，各 Agent 只修改所属路径；跨域契约变更由主 Agent 协调。
8. 修改文件前检查所属目录 AGENTS.md 和 .agents/skills/**/SKILL.md。确保 GitHub Actions 全部通过再合并。
9. 禁止使用真实交易密钥或对生产账号执行自动下单测试；外部 smoke 只读。
