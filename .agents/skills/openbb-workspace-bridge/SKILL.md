---
name: openbb-workspace-bridge
description: 扩展 Rust Gateway 对 OpenBB Workspace 自定义数据后端的 widgets.json/apps.json 与只读 SIP/OPRA Widget。
---
# OpenBB Workspace 兼容层 Skill

1. 优先核对 docs.openbb.co/workspace/developers/data-integration 及原仓 be00e95019a55d57af146919ee46b7e1a4859226 的 Apache-2.0 许可证与 NOTICE。
2. 只创建 widgets.json/apps.json、只读 table/图表数据端点；OpenBB Lite 可选自托管，不允许业务关键路径强制依赖它。
3. 所有数据 endpoint 经过和 EqoBoard REST 相同的 token 鉴权、feed/来源时间戳与错误传播。Origin 精确匹配，不允许 '*'; 禁止将 ALPACA_KEY/SECRET 交给前端。
4. 增加/修改 Widget 时同步 OpenBB manifest、Rust handler、tests/test_openbb_widgets.py、文档，检查 schema、错误、空数据、分页截断。
5. OpenBB Live Grid 需独立实现原生 wsEndpoint/schema 验收，禁止把 EqoBoard 原始 MarketEvent WS 冒充兼容协议。
6. 确认交易所行情分发与图表三方授权；不要复制受限的 TradingView Advanced Charts 专有库。