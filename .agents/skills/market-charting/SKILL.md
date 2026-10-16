---
name: market-charting
description: 使用 Lightweight Charts 5.x 与 Recharts 实现股票 K 线、成交量、期权 IV Skew 等可追溯金融图表。
---
# Charting Skill
Lightweight Charts v5: chart.addSeries(CandlestickSeries)，不能使用 v4 的 addCandlestickSeries；bars 使用 UTC timestamp，输出时间 ET；原始交易所时间戳不能丢。
Recharts：IV 使用真实 Alpaca REST option snapshot model impliedVolatility ×100，遇 null 跳过；IV/Greeks 不是 OPRA 原生数据，没有独立模型时间时必须标 `model as-of unknown`。GEX/OI 需具备独立可信 OI 与合约乘数，不可假填。
默认股票 quote/回报/成交量仍通过 Rust Gateway 请求 SIP（`apps/desk` 按用户要求直接使用富途与 Alpaca IEX）；启用 `EQO_MDP_MARKET_BARS_ENABLED` 后股票/ETF历史 bars 通过同源 `/api/history/{symbol}` 使用 MDP Bars V1，保留每段 Futu/Alpaca/Yahoo 来源、feed 和缺口；OPRA option quote/trade 时间与 REST 模型字段分开标注。UI 只在 Gateway 明确提供匹配的来源身份、实例和时间时标记 LIVE；当前 Gateway 缺少这些字段的 legacy REST 值仍可显示为 source/as-of unknown，不能由 feed 配置推断为 Alpaca。非美国证券、宏观和研究字段保留真实 provider 与 source/as-of，不跨资产类别回退。
Web/Node fixtures 可验证 Next 路由和来源标签，但不能替代 Rust wire/ACK/租约验收，也不能作为真实 SIP/OPRA 权限证据。
管理 ResizeObserver 与 dispose；图上展示 feed 来源、数据时效和完整性。
OpenTerminal 使用 Lightweight Charts 5.x、Recharts、D3 treemap；不要新增平行图表框架。
MDP 归档只复用现有 `ChartWidget` 与已校验的同源 MDP BFF，不直连服务或自行重做市场 DTO 校验。诊断 bars 只能用 bounded finite 数值作为图表坐标，精确 decimal token 保留用于 hover/tooltip；无效或越界投影时整批不绘制。旧归档诊断入口切换来源清空旧 series；统一历史图表的 provider 切换保留 chart/视窗，以 query generation 隔离旧数据。明确显示 `diagnostic`、synthetic/unknown/historical observation 与 NOT LIVE/promotion unavailable，禁止把投影数值用于交易或身份判断。
参考：https://tradingview.github.io/lightweight-charts/docs/5.0

## apps/desk 例外（用户需求优先）

`apps/desk` 的图表使用 Lightweight Charts v5 的 API，但数据来源与窗口按用户要求执行：秒级 1s/5s/10s 由富途逐笔在服务端聚合并保留 1 小时，窗口可选 10/30/60 分钟，坐标轴固定为所选窗口；分钟级最近 20 分钟为富途本地聚合，更早为 Alpaca 历史。成交量随逐笔实时更新。规则以 `apps/desk/AGENTS.md` 为准。
