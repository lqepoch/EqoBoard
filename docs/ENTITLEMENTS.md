# Alpaca Plus 实时 SIP / OPRA 授权诊断

2026-10-07 首次 GitHub Actions 在线检查读取到了组织密钥，但实时 SIP 快照请求返回 HTTP 403。因此当前无法认定所提供的 Paper Key 具备 Algo Trader Plus 实时股票权限。

已调整只读 smoke：
- 独立检查 GET /v2/stocks/QQQ/snapshot?feed=sip
- 独立检查 GET /v1beta1/options/snapshots/QQQ?feed=opra&limit=1
- 如实时 SIP 返回 403，增加 45 分钟以前的 SIP 历史 bars GET 诊断，用于区分旧 SIP 可读与当前 SIP 无权；不降级为 IEX 或期权 indicative。
- 分别报告 SIP、OPRA 的成功、403 或异常；Secret 和源响应 body 一律不写日志。

排查：确认 Alpaca Algo Trader Plus 状态 ACTIVE；组织 Secrets 绑定的 Key / Secret 与享有 Plus 的账户 owner 一致且未被轮换；从主分支重新运行 Alpaca SIP + OPRA read-only smoke。若持续 403，联系 Alpaca 支持并提供响应数值 code、endpoint、时间，避免提供敏感密钥。

官方参考：
- https://docs.alpaca.markets/us/docs/market-data-faq
- https://docs.alpaca.markets/us/docs/about-market-data-api
- https://docs.alpaca.markets/us/reference/optionchain
