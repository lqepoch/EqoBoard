# EqoBoard Agent 工作约定（所有子目录生效）

目标：优先复用成熟金融终端能力，保持市场数据来源真实、交易失败关闭、接口可审计。

1. 主 UI 目录为 `apps/openterminal`。Workspace、Widget 生命周期、Command Palette、图表和研究组件优先同步/扩展固定版本 OpenTerminal。
2. 期权大表统一使用 AG Grid Community；高频报价使用批量 transaction，避免每个 tick 触发整表 React 更新。
3. OpenBB 位于 `integrations/openbb` + Rust Gateway 兼容层，只读共享同一 SIP/OPRA 数据契约。
4. Rust 业务模型在 `crates/domain`，Alpaca 在 `crates/alpaca-data`，执行在 `crates/execution`，HTTP/WS/SSE 在 `apps/gateway`。
5. ALPACA_KEY / ALPACA_SECRET 只进入服务端环境；PR CI 不读取组织行情密钥；日志禁止记录凭据。
6. 行情缺失或 entitlement 失败必须显式呈现；禁止把 mock、IEX、indicative 或第三方免费源标记成 SIP/OPRA。
7. live 委托持续拒绝。Paper 必须经过 Preview、限额、原子多腿、幂等、审计、未知状态恢复和券商端二次核验。
8. 上游升级先检查 `third_party/upstreams.lock.json`、LICENSE/NOTICE、diff、供应链风险，再运行完整 CI。
9. 修改前阅读所属目录 AGENTS.md 与对应 `.agents/skills/**/SKILL.md`。
