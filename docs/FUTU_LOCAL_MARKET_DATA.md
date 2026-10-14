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
市场时间保留 unknown。历史 K 线由同一个 Gateway 常驻本机 helper 进程通过
官方 `futu-api@10.11.7108` 的 `RequestHistoryKL` 读取，不创建实时订阅，
不占用 QUOTE/ORDER_BOOK/TICKER 订阅槽；历史数据仍受单独的 Futu 历史 K 线
额度和账户行情权限约束，`source_entitlement` 保持 `unknown`。

历史 bars 保留旧 `days`（默认 14，范围 1..11000）、`timeframe` 和 `limit`
（默认 200，范围 1..1000）；也可传成对的 RFC3339 UTC `start` / `end` 与
`cursor`。分钟级按 UTC 半开区间 `[start,end)` 过滤。日/周/月 K 线按开始和
结束瞬间对应的美东日期选择交易日，结束边界使用 `end - 1ms`；不会把日 K
按 UTC 午夜分钟戳误删。SDK 的 K 线 `time` 是没有时区后缀的美东墙上时间，
通过 IANA `America/New_York` 映射到 UTC，同时保留原始 `event_time_et` 和
实际响应接收时间 `received_at`。春季跳时的不存在时间和秋季回拨的歧义时间
会使整页返回 `UNSUPPORTED_PROVIDER_CAPABILITY`，不按固定偏移猜测。

美国股票的分钟 K 线（不高于 60 分钟）请求 `Session.ALL`，官方说明该会话
包含 24 小时历史 K 线，OpenD 最低版本为 9.2.4207；日/周/月请求常规会话，
因为盘前、盘后和夜盘历史只支持不高于 60 分钟的粒度。官方限制为分钟 K 线
最多回溯 8 年、日 K 最多回溯 20 年，非正常时段历史可能不足 2 年；实际结果
还取决于 OpenD 版本和账户权限。每次 helper 请求最多取 SDK 一页，服务端 opaque
cursor 绑定完整查询并保留 SDK 原始 `nextReqKey`；cursor 在常驻进程内有效
30 分钟，每个查询最多 20 页，单进程最多缓存 256 个 cursor。helper 请求间隔
至少 500ms，按不超过每 30 秒 60 次限制执行，包括后续页。若 OpenD 重连，
旧 cursor 失效，应从首页重试。

SDK 用 protobuf `double` 返回 OHLC；价格按十进制文本投影，科学计数法只做词法展开，
不舍入，并明确标记 `numeric_encoding=binary_float_projection`，不能当作来源精确
十进制。投影超出 Core `DecimalString` 的长度、scale 或系数范围时整页拒绝。成交量
保留为整数十进制文本，来源缺值为 `null`；固定使用 `rehabType=None`，响应标记
`adjustment=none`。不填零、不造 tick-bar 或成交量。
官方历史 K 线额度按股票在滚动 7 天内计算，与实时订阅额度分开；读取历史页
可能消耗历史额度。历史 K 线频率上限是每 30 秒 60 次，官方说明该限制只作用
于分页首请求；helper 仍对全部页统一限频，避免重连或多调用方时超限。

当前代码验证为 synthetic/provider-contract tests。只读检查发现本机现有
OpenD 的 loopback WebSocket 可建立传输连接，但 helper 初始化返回失败
（`InitWebSocket` 响应 `retType=-1` 且没有 `s2c`），因此未发送历史 K 线请求，
也没有消耗历史额度或触碰实时订阅。Gateway env 的 loopback 地址和端口与
listener 一致；旧 XML 不含 SSL/key，OpenD 启动参数引用的运行时 XML 已被
删除，不能确认现有 env key 是否匹配当前 OpenD 配置。真实 provider 验收标记为
`BLOCKED_EXTERNAL`，需要操作者核对当前本机 WebSocket key/权限后再测。为该只读
诊断启动的 OpenD GUI 已退出并恢复原先无 listener 的状态。实时逐笔推送仍需
交易时段验收。历史 K 线及 OpenD 行情不用于任何订单。

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
Gateway 启动一个常驻 SDK 子进程，不按请求新建连接；stdin/stdout 使用有界
NDJSON 队列，Gateway 单行读取预算为 1 MiB，超限会关闭 worker 并结束待处理请求。
OpenD 登录拒绝以脱敏错误码 `futu_login_rejected` 返回，不转发 SDK 原始错误。
`method=bars` 请求接收 `days` 或成对 `start`/`end`，以及可选
`cursor`；opaque cursor 仅在该 worker 进程存活期间有效，重启后须从首页查询。
SDK 原始日志禁用，不调用 Futu 解锁/交易 API。

检查：`node --test tools/futu-subscriptions.test.mjs`；
`node --import ./apps/openterminal/node_modules/tsx/dist/loader.mjs --test tools/local-access.test.ts`；
`cargo +1.99.0 test -p eqo-gateway --locked`；server test/build、web typecheck/build。
历史 helper synthetic 测试覆盖 SDK 请求参数、Session.ALL、ET/DST 转 UTC、
日 K 交易日窗口、半开分钟窗口、opaque 分页、20 页上限、限速、超时重试、
权限错误映射和价格/成交量精度元数据；不代表真实 OpenD provider 验收。
已有本机 HTTP 验证覆盖网页 200、local readyz、QQQ/SPY Futu 快照、跨源 403
和 Paper 提交 409（未调用券商）。推送及真实下单尚未验收。

回滚：停止本任务进程，移除本机模式/Futu provider 配置，恢复已有 OIDC/Alpaca
路径；不改变账户、交易状态、数据或其他任务 worktree。

官方依据：[Futu 历史 K 线协议与限制](https://openapi.futunn.com/futu-api-doc/quote/request-history-kline.html)、
[历史 K 线额度与请求限频](https://openapi.futunn.com/futu-api-doc/intro/authority.html)、
[订阅](https://openapi.futunn.com/futu-api-doc/quote/sub.html)、
[订阅信息](https://openapi.futunn.com/futu-api-doc/quote/query-subscription.html)、
[Alpaca Paper](https://docs.alpaca.markets/us/docs/paper-trading)。
