---
name: market-charting
description: 使用 Lightweight Charts 5.x 与 Recharts 实现股票 K 线、成交量、期权 IV Skew 等可追溯金融图表。
---
# Charting Skill
Lightweight Charts v5: chart.addSeries(CandlestickSeries)，不能使用 v4 的 addCandlestickSeries；bars 使用 UTC timestamp，输出时间 ET；原始交易所时间戳不能丢。
Recharts：IV 使用真实 Alpaca REST option snapshot model impliedVolatility ×100，遇 null 跳过；IV/Greeks 不是 OPRA 原生数据，没有独立模型时间时必须标 `model as-of unknown`。GEX/OI 需具备独立可信 OI 与合约乘数，不可假填。
美国股票价格、回报、成交量和历史 bars 使用 Rust Gateway 的 Alpaca SIP；OPRA option quote/trade 时间与 REST 模型字段分开标注。非美国证券、宏观和研究字段保留真实 provider 与 source/as-of，不跨资产类别回退。
管理 ResizeObserver 与 dispose；图上展示 feed 来源、数据时效和完整性。
OpenTerminal 使用 Lightweight Charts 5.x、Recharts、D3 treemap；不要新增平行图表框架。
参考：https://tradingview.github.io/lightweight-charts/docs/5.0
