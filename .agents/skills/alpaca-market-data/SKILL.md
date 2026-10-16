---
name: alpaca-market-data
description: 实现与核验 Alpaca Plus 股票 SIP / 期权 OPRA 数据采集、实时流、分页、报价规范化与异常追踪。
---
# 行情接入 Skill

适用范围：crates/alpaca-data/**、相关 gateway REST/WS 契约。
工作步骤：核验当前官方文档和账号 entitlement → 确认 feed/symbol/timeframe → 写 source + timestamp 保真 DTO → 构造快照/消息单元测试 → 验证 401/403/429、断连和重复订阅 → 评估限频、限额与缓存 → 运行 cargo fmt/clippy/test → 更新 docs/ARCHITECTURE.md。
新共享 wire DTO 使用固定版本 `trading-core/market-contracts`；`eqo-domain` 的 legacy DTO 仅为现有消费者提供兼容形状。不要把 legacy `f64` 当作精确十进制行情，或用本机接收时间补造缺失的 source timestamp。
禁止：隐式 IEX/indicative 回退、把请求时间伪装为成交时间、凭据进浏览器、500 合约每个建独立 WS。
参考资料：references/alpaca-endpoints.md；回归脚本 tools/check_alpaca_feeds.py 只读。

## apps/desk 例外（用户需求优先）

本地行情台 `apps/desk` 按用户要求直接读取 Alpaca 数据，不经 Rust Gateway。它显式指定 `feed=iex` 拉取股票 K 线，显式指定 `feed=indicative` 拉取期权快照；这是请求参数的显式选择，不是隐式回退。期权报价延迟以服务端返回的报价时间实测，不写死。IV 与希腊字母不由该数据源提供，显示为 `—`。规则以 `apps/desk/AGENTS.md` 与 `.agents/skills/equity-desk/SKILL.md` 为准。
