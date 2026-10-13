# 本机 Futu 行情与 Alpaca Paper 配置

2026-10-13：本任务使用官方 `futu-api@10.11.7108` 经本机 OpenD WebSocket
接入现有 Rust Gateway / OpenTerminal BFF。默认部署仍使用 Alpaca/OIDC。
选择 `EQO_MARKET_DATA_PROVIDER=futu` 后不回退到 Alpaca。

## 股票

QQQ/SPY 常驻 QUOTE、ORDER_BOOK、TICKER（三个类型/股票）；其他股票按有效
消费者并集订阅，额外缓存最多 30 只，不含 QQQ/SPY。满缓存占 96 个额度，
上限 100；GetSubInfo 同时扣除其他连接占用。只淘汰非活跃、非常驻、订阅已满
一分钟的 LRU 项，反订阅 ACK 后重新读取额度；不取消其他连接的订阅。
没有可释放项时等待。来源明确标为 Futu OpenD，不冒称 SIP/OPRA；订单簿缺
市场时间保留 unknown。股票历史 bars 暂不可用，实际逐笔推送需交易时段验收。

期权按用户最新要求暂停，不查询/订阅。美国期权当前无权限。股票/期权配额
独立，未来期权链按标的+到期日×类型计费，同链 Call/Put、执行价共享链配额。

## 本机免登录

设置 `EQO_LOCAL_ACCESS=true`、`EQO_LOCAL_BIND=127.0.0.1`，相同的
`EQO_PUBLIC_ORIGIN` / `NEXTAUTH_URL=http://localhost:3000`，并以
`npm run dev -w web -- --hostname 127.0.0.1` 启动。Web、Node、Gateway 必须
实际仅监听 loopback；Gateway 在该模式或 Futu 模式拒绝 non-loopback bind。
该模式必须显式启用，独立 research runtime 不接受。缺省仍为 OIDC。

本机主体 `local-workstation` 的 issuer 是本机 origin 下的 `/local-access`，
不冒称 OIDC。权限覆盖市场、workspace、私有研究、订单预览和 Paper scope；
没有 Live 或 Engine scope。保留 Host/Origin/Fetch Metadata 及写入大小、超时
检查，下游仍使用独立 key 签发最长 60 秒的 scope JWT。私有研究 scope 不替代
Quant 外部服务自身的 OIDC、数据读取门禁和运行配置。

## Alpaca Paper

已有本机凭据通过只读 `GET https://paper-api.alpaca.markets/v2/account` 验证：
ACTIVE，账户和交易未被阻断；未发送订单。凭据独立存放在仓库外 0600 配置，
未加载到 Web、Git 或日志，与 Futu 行情密钥分离。

当前仅验证账户连通性：requested mode 为 paper，但 Gateway/BFF effective
execution 仍 disabled，实际提交返回 blocked。现有持久 preview/outbox、账户
绑定、恢复和对账执行服务未完成；Paper scope 与 ACTIVE 不等于可以下单。
继续复用 broker-connectors / 独立执行服务职责，不在 EqoBoard 重写执行系统。
Live 不启用，不删除门禁来开通 Paper。

## 配置、检查和回滚

Gateway 的 `EQO_FUTU_SCRIPT` 指向本仓 `tools/futu-stdio.mjs`；
`FUTU_OPEND_HOST=127.0.0.1`、`FUTU_OPEND_WEBSOCKET_PORT`、
`FUTU_OPEND_WEBSOCKET_SSL`、`FUTU_OPEND_WEBSOCKET_KEY` 仅传给 Gateway
和其 SDK 子进程。当前 WebSocket 为 127.0.0.1:33333，TCP 为 11111，不能混用。
私有 stdout NDJSON 队列有界，SDK 原始日志禁用，不调用 Futu 解锁/交易 API。

检查：`node --test tools/futu-subscriptions.test.mjs`；
`node --import ./apps/openterminal/node_modules/tsx/dist/loader.mjs --test tools/local-access.test.ts`；
`cargo +1.99.0 test -p eqo-gateway --locked`；server test/build、web typecheck/build。
本机 HTTP 已验证网页 200、local readyz、QQQ/SPY Futu 快照、跨源 403 和
Paper 提交 409（未调用券商）。推送及真实下单尚未验收。

回滚：停止本任务进程，移除本机模式/Futu provider 配置，恢复已有 OIDC/Alpaca
路径；不改变账户、交易状态、数据或其他任务 worktree。

官方依据：[Futu 额度](https://openapi.futunn.com/futu-api-doc/intro/authority.html)、
[订阅](https://openapi.futunn.com/futu-api-doc/quote/sub.html)、
[订阅信息](https://openapi.futunn.com/futu-api-doc/quote/query-subscription.html)、
[Alpaca Paper](https://docs.alpaca.markets/us/docs/paper-trading)。
