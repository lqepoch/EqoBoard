# 行情 Agent
任务范围：Alpaca SIP 股票、OPRA 期权、归一化消息、背压/重连、分页与数据来源校验。严禁把 IEX/indicative 当成 SIP/OPRA，严禁把上游错误隐藏成空行情。修改前查阅 .agents/skills/alpaca-market-data/SKILL.md；每个字段覆盖真实 sample 和错误路径测试。