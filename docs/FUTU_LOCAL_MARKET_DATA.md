# 本地 Futu 行情接入：需求与待验证边界

状态：接入尚未实现。本文记录本次用户指定的行为和已核对的供应商规则，
不是运行验收，也不表示现有 Alpaca 路由已经切换。

## 来源和运行边界

- 新行情来源为本机 Futu OpenD，通过服务端 WebSocket 订阅接入现有 Rust
  Gateway 和 OpenTerminal。浏览器继续通过同源 BFF，不能直连 OpenD。
- 复用官方 SDK/现有接入能力，避免重写供应商协议或另建终端。
- Futu 来源必须显式标识，不能沿用 Alpaca/SIP 标签，也不能由连接成功推断
  股票或期权权限、新鲜度和完整性。失败不自动回退到 Alpaca。
- Gateway/BFF 的身份校验不因行情来源切换而取消。交易执行仍为 disabled；
  接入不得调用交易解锁、账户交易操作或下单接口。

## 股票订阅

- QQQ、SPY 的 QUOTE（报价）和 TICKER（逐笔）常驻。
- 其他股票只在用户打开时按 Widget 所需类型订阅。ORDER_BOOK 和实时 K 线
  等类型按实际需求增加，不默认把所有类型订阅给每个股票。
- 最多缓冲 30 个非 QQQ/SPY 股票。缓存集合不包含两个常驻标的。
- 超限时淘汰未被当前页面/其他有效消费者使用的最久未访问股票；多个
  Widget/标签页共享同一上游订阅并集，不能因单个页面释放而取消他人需求。
- 股票配额上限为用户当前的 100；按 `证券代码 × 订阅类型` 计费，缓存数
  上限不代替配额检查。四个类型订阅同一股票就占四个股票配额。
- 容量不足时可以在到达 30 个股票之前提前淘汰可释放的旧缓存。没有安全
  可释放项时返回明确的配额等待/不足状态，不能释放 QQQ/SPY 或活跃需求。
- 订阅至少一分钟后才可反订阅。等待释放的订阅仍计入预算，只有供应商
  确认和重新读取配额后才能计为可用；不得修改其他 OpenD 连接的订阅。

## 期权订阅

- QQQ、SPY：0DTE、1DTE、2DTE；目标链同时包括 Call 和 Put。
- TQQQ：供应商返回的最近三个尚可交易的实际到期日；目标链同时包括
  Call 和 Put。不能用三天自然日代替实际上市到期日。
- QQQ/SPY 的 DTE 日期语义需在接入前明确：自然日距离与交易日距离不能
  混用。不存在或已不可交易的到期日应明确显示缺失，不静默换约。
- 到期日和合约集合来自 OpenD 元数据，不从 OCC 字符串或固定周五规则
  推测上市/可交易性。行情原始 Futu 合约代码与共享展示符号须可追溯映射。
- 期权配额与股票配额独立，按 `期权链（标的 + 到期日）× 订阅类型`
  计费；同链的 Call、Put 和不同执行价不是各自一份链配额。
- 最多九条目标链若都订阅 QUOTE + TICKER，理论占用 18 个期权配额；
  不存在的链不占用。增加第三种类型理论达到 27，不能假设当前 20 配额
  足够。实际预算还须扣除 OpenD 上其他连接使用的额度。
- 查询订阅信息时分别使用 `totalUsedQuota` / `remainQuota` 与
  `optionUsedQuota` / `optionRemainQuota`。缺失期权字段不按零使用量或无限
  额度处理；实际 ACK、权限和完整合约覆盖需分别验证。

## 当前本机阻断

2026-10-13 核对：OpenD 版本 10.11.7108，GUI 显示股票订阅额度 100、期权
订阅额度 20；美国股票 LV3，美国期权无权限。发现 `127.0.0.1:11111` TCP
API 监听，该端口未响应 WebSocket HTTP Upgrade，尚未发现 WebSocket
监听。不能把 TCP API 端口当作已经可用的 WebSocket 入口。

真实接入还需本机 WebSocket 端口/配置、美国期权行情权限，以及已有
OpenTerminal OIDC 配置。本文不包含任何密钥或账户标识。

## 验证要求

实现需覆盖独立股票/期权预算、同链 Call/Put 去重计费、30 个额外股票
缓存、常驻/活跃标的保护、一分钟反订阅等待、ACK 失败不释放预算、
其他连接占用、断线重连、到期日滚动及明确的权限错误。必须有离线测试，
再以只读本机接口验证真实订阅和推送，不能用 mock 验证宣称行情已接通。

官方依据：

- [权限与额度](https://openapi.futunn.com/futu-api-doc/intro/authority.html)
- [订阅与反订阅](https://openapi.futunn.com/futu-api-doc/quote/sub.html)
- [查询订阅状态](https://openapi.futunn.com/futu-api-doc/quote/query-subscription.html)
- [期权到期日](https://openapi.futunn.com/futu-api-doc/quote/get-option-expiration-date.html)

官方 `futu-api@10.11.7108` 的 `Qot_GetSubInfo.proto` 同时定义股票和期权
配额字段；复核时应保留字段缺失与显式零值的区别。
