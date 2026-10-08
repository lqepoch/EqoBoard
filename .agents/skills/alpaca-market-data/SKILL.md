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
