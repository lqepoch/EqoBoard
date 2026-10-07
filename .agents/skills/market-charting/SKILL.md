---
name: market-charting
description: 使用 Lightweight Charts 5.x 与 ECharts 实现股票 K 线、成交量、期权 IV Skew 等可追溯金融图表。
---
# Charting Skill
Lightweight Charts v5: chart.addSeries(CandlestickSeries)，不能使用 v4 的 addCandlestickSeries；bars 使用 UTC timestamp，输出时间 ET；原始交易所时间戳不能丢。
ECharts：IV 使用真实快照 impliedVolatility ×100，遇 null 跳过；GEX/OI 需具备独立可信 OI 与合约乘数，不可假填。
管理 ResizeObserver 与 dispose；图上展示 feed 来源、数据时效和完整性。
参考：https://tradingview.github.io/lightweight-charts/docs/5.0
