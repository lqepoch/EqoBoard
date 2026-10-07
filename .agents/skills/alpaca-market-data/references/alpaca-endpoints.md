# Alpaca 官方接口核验记录（2026-10-07）
股票 REST: https://data.alpaca.markets/v2/stocks/snapshots?symbols=QQQ&feed=sip
股票流: wss://stream.data.alpaca.markets/v2/sip，文本 JSON
股票 K 线: https://data.alpaca.markets/v2/stocks/QQQ/bars?timeframe=1Min&feed=sip
期权链: https://data.alpaca.markets/v1beta1/options/snapshots/QQQ?feed=opra&expiration_date=2026-10-07
期权流: wss://stream.data.alpaca.markets/v1beta1/opra；握手 Content-Type: application/msgpack，返回二进制 MsgPack
快照上限: 每页最高 1000，next_page_token 继续；合约直查 snapshots 上限 100 个 symbol。
订阅上限: 以账号实际 entitlement 为准；期权 quotes 不允许 *。
文档：
- https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data
- https://docs.alpaca.markets/us/docs/real-time-option-data
- https://docs.alpaca.markets/us/docs/streaming-market-data
- https://docs.alpaca.markets/us/reference/optionchain
- https://docs.alpaca.markets/us/reference/stocksnapshots-1

禁止每次 UI 展开 500 合约就对 Alpaca 单独建立 500 条连接；只有共享采集服务持凭据。
