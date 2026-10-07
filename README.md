# EqoBoard

**股票 + 美股期权专业交易看板｜Equities & Options Terminal**

EqoBoard 是可二次开发的开源单用户自托管金融终端：Alpaca **Algo Trader Plus** 提供股票 SIP / 期权 OPRA 数据；Rust 网关统一鉴权、期权链分页与高频推送；可切换 Alpaca、IBKR、Schwab 的独立 Rust 交易执行服务。所有订单写操作默认关闭。

> 项目状态：**基础工程（Foundation）**。已覆盖股票报价与 K 线、期权链快照 / Greeks、共享行情流、垂直价差预览、可审计的交易适配器入口和 CI。订单执行还需连接并验收各券商独立 Rust 执行服务；请先完成 Paper 验证。不能仅凭 UI 状态认定订单已成交。

## 运行要求

- Node.js 22+、npm 10+；Rust stable；Alpaca 账户具备股票 SIP 与期权 OPRA 授权。
- 本地环境：复制 .env.example 为 .env，填写 ALPACA_KEY、ALPACA_SECRET（仅后端读取）。
- 启动网关：cargo run -p eqo-gateway
- 启动 UI：cd apps/web && npm install && npm run dev
- 打开 http://localhost:5173；Vite 将 /api 和 /healthz 代理到 127.0.0.1:8080。
- Rust 服务器可直接托管 apps/web/dist（运行 npm run build 后）。

### 测试

\`\`\`sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/web && npm install && npm run typecheck && npm run test && npm run build
\`\`\`

没有密钥时 UI 明确显示行情不可用，**绝不会制造模拟报价或虚构成交**。CI 离线单元测试完全不需要密钥；market-data-smoke 工作流手动或定时用组织 Secrets \`ALPACA_KEY\` / \`ALPACA_SECRET\` 进行只读订阅验证。

## 上游成熟框架复用（2026-10-07）

- **OpenTerminal**：正式将 web/store/terminal.ts、Workspace、CommandPalette 和 Symbol 工具的 MIT 上游模式移植到 apps/web/src/upstream/openterminal，保留原许可证及固定 commit；首页已经使用此 Widget registry / draggable workspace。它的 Yahoo 等免费行情链没有带入。
- **AG Grid Community**：apps/web/src/components/OptionChain.tsx 持续采用 v36.2.0，双侧期权链和 applyTransactionAsync 直接使用 AG Grid。
- **OpenBB Workspace**：实现了官方 Custom Backend widgets.json / apps.json + Rust 只读 SIP/OPRA API，使用 OpenBB 自托管 Lite 时可在 Data Connectors 添加 EqoBoard。OpenBB 完整 UI 没有嵌进本程序；其官方原仓 2026-10-01 已归档开源，适合作可选分析界面，不影响主交易台运行。
- **Rust/Tokio**：全部 Alpaca Plus SIP/OPRA 和 BrokerAdapter 继续由 EqoBoard 后端管理，浏览器不能触达密钥。

详细来源、许可证和适配边界见 docs/UPSTREAM_SOURCES.md；OpenBB 接入见 integrations/openbb/README.md。

⚠ **实测权限**：2026-10-07 Actions 检查当前组织 ALPACA_KEY/ALPACA_SECRET 对实时 SIP 和 OPRA 均返回 HTTP 403；45 分钟前 SIP 历史请求可用。必须核对 Plus 订阅归属，绝不静默改用 IEX/indicative。

## 技术选型

| 模块 | 技术 | 原则 |
|---|---|---|
| Web | React 19 / Vite / TypeScript | 低延时 SPA，路由按领域模块划分 |
| Option Chain | AG Grid Community | 行虚拟化、列配置、增量更新 |
| 股票 K 线 | Lightweight Charts | 独立于行情数据源的绘图 |
| 期权分析 | ECharts | IV、成交量、价差等指标，指标必须标明来源和算法 |
| Rust Gateway | Axum / Tokio | 单一行情出口、鉴权、路由、故障隔离 |
| 行情 | Alpaca data REST + 股票 SIP / 期权 OPRA WebSocket | 不在客户端暴露 Key，不私自切到延迟/indicative |
| Execution | 独立 Rust BrokerAdapter HTTP 契约 | disabled → paper；实时交易尚未开放 |

完整设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md)、[docs/SECURITY.md](docs/SECURITY.md)。Agent 规范见 [AGENTS.md](AGENTS.md)，局部 Agent / Skills 位于对应子项目。

## 数据语义与局限

- **SIP、OPRA 只是指定请求的数据源**；实际是否有权限由 Alpaca 服务端决定。401/403/429 显式告警并保持来源，不采用隐式降级。Plus 限额/授权以账户实际结果为准。
- OPRA 期权链的 IV/Greeks 是 Alpaca 快照字段，不代表交易所直接广播 Greeks；非同一时刻的两腿 mid 不保证可成交。
- 成交量、持仓量、GEX、IV Surface 的计算需要额外数据完备性校验；基础工程只展示已提供的真实指标，未提供的指标显示无数据。
- WebSocket 行情数据适合界面与分析，订单价格/风控仍由**执行服务在下单瞬间重校验**。
- 当前只提供个人开发/自托管边界。若提供给第三方用户，必须另行取得市场数据分发许可，接入 OIDC/细粒度租户鉴权和强制持久化风控审批。

许可证：MIT；第三方组件各自遵循其许可证。市场数据订阅和再分发遵循 Alpaca/交易所协议。
