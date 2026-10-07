# 架构与演进

## 数据路径

\`\`\`
Alpaca SIP (stocks) ──┐
                      ├── eqo-alpaca-data ── Rust Axum Gateway ── /api/v1 + WS ── Web Terminal
Alpaca OPRA (options) ┘          │
                             快照/分页/单位转换/时间戳/来源标签
                                   │
Browser 订单意图 → 风险预览(60秒一次性ID) → 明确确认 → Broker Router
                                                       ├── alpaca → Rust service
                                                       ├── ibkr   → Rust service
                                                       └── schwab → Rust service
\`\`\`

## 固定接口

- GET /healthz 仅就绪探针。
- GET /api/v1/status 包含数据源、交易门闩、可用适配器（不含密钥）。
- GET /api/v1/stocks/snapshots?symbols=SPY,QQQ：SIP 多标的快照。
- GET /api/v1/stocks/bars?symbol=QQQ&timeframe=1Min&limit=200：SIP K 线。
- GET /api/v1/options/chain?underlying=QQQ&expiration=YYYY-MM-DD：OPRA 链；分页有硬上限且返回 truncated。
- POST /api/v1/subscriptions/options：在授权范围内设置当前共享 OPRA 订阅集合。
- GET /api/v1/stream：浏览器 WebSocket，接收归一化行情，批量推送和新订阅检查均通过后端。
- POST /api/v1/orders/preview：只做语义及额度校验，60 秒后预览失效。
- POST /api/v1/orders/submit：要求 preview_id + confirm=true + enabled paper 配置；使用唯一 idempotency key 发送至所选后端。

## 可靠性/约束

1. **来源一致性**：禁止将 IEX 标成 SIP，禁止将 indicative 标成 OPRA；保留上游时间戳、交易所字段与更新延迟。
2. **单上游连接**：每种 feed 一个 Tokio 任务，多个浏览器共享广播通道。Reconnect 使用指数退避 + jitter；新连接重订阅，错误写入日志。
3. **限流/缓存**：期权链限总页数 / 每页 1000；后台应按需求加单飞缓存、符号订阅配额和延迟分层。
4. **UI**：REST 初始快照 + WS delta；可丢弃过时视图更新，不可丢弃订单生命周期消息。断流须标红并显示 as-of 时间。
5. **故障恢复**：execution timeout 返回 unknown（需由执行服务按 client_order_id 查询）；禁止盲目重试造成重复委托。
6. **存储**：初始审计为 append-only JSONL；生产接 PostgreSQL/Timescale + schema migration、凭证审计、订单/成交事件存储、监控与恢复演练。
7. **合规**：OPRA/SIP 可能限制第三方分发与数据留存，所有 Web API 仅提供经授权的单账户使用场景。

## 交付门槛

Foundation（本次）：启动、行情快照、WS、只读页面、无凭据 CI、适配器契约、风险门闩与只读外部 smoke。
Paper MVP（后续）：统一订单生命周期、IB Gateway/Schwab SDK 端到端 Paper、对账、断连/幂等恢复、重放测试。
Production：SLO、集中观测、分布式订阅协调、OIDC、审计 WORM、限额及审批、灰度/回滚、secret rotation、容灾；通过市场数据授权复核。


## 成熟前端复用（2026-10-07）

OpenTerminal MIT 源码移植层是 EqoBoard React 主 Workspace 的权威 Widget registry、布局持久化和 Command Palette；StockChart 使用 Lightweight Charts，OptionsChain 使用 AG Grid Community，IV Skew 使用 ECharts。全部读 Rust SIP/OPRA。

OpenBB Workspace（官方源码 2026-10-01 已归档，Apache-2.0）作为**可选、可替换的第二分析界面**，通过本 Rust Gateway 的 /widgets.json、/apps.json 和 /openbb/v1/ 只读端点接入，不持有 Alpaca 凭据，不拥有下单权限。详见 integrations/openbb/README.md。
