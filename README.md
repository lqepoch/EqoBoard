# EqoBoard

可二次开发的美股股票 + 期权终端。默认本地 UI 直接复用 **OpenTerminal** 的 MIT Workspace/Widget/Chart 体系；期权链使用 **AG Grid Community**；美股/期权数据路径请求 Alpaca Plus 的 **SIP/OPRA**。仓库保留 OpenBB Workspace 兼容清单与 Gateway 研究 API；OpenBB UI 尚未嵌入主终端，认证 Workspace/Lite 联调属于后续 #13。

## 核心组合

| 层 | 采用组件 | EqoBoard 扩展 |
|---|---|---|
| 主终端 | OpenTerminal @ pinned upstream commit | SIP/OPRA 路由、AG Grid Option Chain、IV Skew、OPRA Tape、Vertical Spread |
| 表格 | AG Grid Community 36.2 | 高频 async transaction、双边期权链 |
| 图表 | OpenTerminal Lightweight Charts + Recharts | Alpaca SIP K线、OPRA IV |
| 行情 | Rust + Tokio + Axum | SIP/OPRA REST/WS、50ms 批处理、租约、来源/时间戳 |
| 研究兼容入口 | Gateway 中的 OpenBB Workspace manifests/API | `widgets.json`、`apps.json`、受保护研究 API；#13 客户端认证联调未完成 |
| 执行 | Rust BrokerAdapter | 当前版本 effective mode 固定为 disabled；Paper 和 Live 均不提交 |

OpenTerminal 原始代码保留在 `apps/openterminal`，上游许可与固定提交见 [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)。旧的自研 Vite 终端已退出仓库，防止两套 UI 长期分叉。

OpenBB 兼容资源位于 `apps/gateway/openbb/` 与现有 Gateway 路由；当前 OpenTerminal 页面没有 OpenBB Workspace 导航入口。该兼容面不是已验收的第二套可登录终端，真实 OpenBB Lite/OIDC 委托联调继续由 #13 跟踪。

浏览器只建立 **1 条 EqoBoard SSE 行情连接**。Quote、Watchlist、AG Grid Option Chain、OPRA Tape 共用这条 50ms 批量流；股票 Watchlist/活动 Widget 通过租约合并为一条 Alpaca SIP 上游订阅。REST 快照用于初始状态与周期校准。

## 启动

复制 `.env.example` 为 `.env`。要启用终端登录，配置受信 OIDC issuer、客户端和三个彼此独立的签名密钥：

```bash
openssl rand -hex 32 # 分别生成四次，不要复用
```

将不同生成值写入 `.env`：

```dotenv
EQO_OIDC_ISSUER=https://identity.example.com
EQO_OIDC_CLIENT_ID=...
EQO_OIDC_CLIENT_SECRET=...
NEXTAUTH_SECRET=<独立随机值，至少32字符>
EQO_GATEWAY_JWT_SECRET=<独立随机值，至少64个可打印字符>
EQO_RESEARCH_JWT_SECRET=<独立随机值，至少64个可打印字符>
EQO_RESEARCH_API_KEY=<独立随机值，至少32字符>
```

同时将 `EQO_PUBLIC_ORIGIN` 与 `NEXTAUTH_URL` 设为浏览器访问的同一个 HTTPS origin，并在 OIDC 客户端登记 `${EQO_PUBLIC_ORIGIN}/api/auth/callback/eqo-oidc`。本机开发允许 loopback HTTP。Alpaca SIP/OPRA 凭据是可选的服务端变量；没有凭据时行情不可用，不会回退到其他来源。配置项和权限要求见 [部署说明](docs/DEPLOYMENT.md)。

运行：

```bash
docker compose up --build
```

入口：

- `http://127.0.0.1:3000`：OpenTerminal 主终端。
- `http://127.0.0.1:8080`：仅本机可访问的 Rust Gateway API；research Node API 不发布宿主端口。
- 浏览器只访问 OpenTerminal BFF。Rust API 不接受静态用户 token，也不把客户端身份头当作身份凭证。

本地开发：

```bash
# 在两个终端分别执行；先按上文完成 .env 中的认证设置
set -a && source .env && set +a
cargo run -p eqo-gateway
```

另一个终端：

```bash
set -a && source .env && set +a
cd apps/openterminal
npm ci
npm run dev
```

## 当前边界

- 股票关键行情固定请求 SIP，期权关键行情固定请求 OPRA；401/403/429 原样转为显式状态，不做隐藏回退。
- OpenTerminal 的 FRED、SEC、FINRA、新闻、宏观等研究 Provider 保留；股票/期权价格与历史图表通过 EqoBoard Rust Gateway。
- 所有 BFF 路由都要求 OIDC 会话和对应 action scope；写请求还要通过同源校验及有界 JSON 请求检查。`EQO_ACCESS_TOKEN` 已废弃。
- `/api/quotes` 与美股 `/api/history/:symbol` 只把美国上市股票/ETF发往 Rust SIP；VIX、已支持 crypto、海外挂牌后缀继续走对应研究 Provider。SIP 失败显式返回，不回退到 Yahoo 等来源。OpenBB 兼容路由仍受 Gateway 委托身份保护；OpenBB Lite 登录/令牌联调属于后续 #13，不使用静态 bearer token。
- 登录配置缺失时页面会显示身份服务不可用，受保护 BFF 不向下游发请求。`/healthz` 是进程存活检查；`/readyz` 的身份就绪不代表 SIP/OPRA entitlement 或行情已就绪。
- 订单预览是离线风险检查，并绑定验证后的 OIDC `(issuer, subject)`；Paper submit 当前始终 blocked，Live 始终拒绝。Gateway status 将 adapter endpoint 配置和券商执行 capability 分开报告，Alpaca/IBKR/Schwab 的 Paper 和 Live capability 均 disabled；持久 preview/outbox、账户身份和真实 broker Paper 能力完成前不会开放提交。超时结果为 `UNKNOWN` 时保留 `client_order_id` 和原 preview 恢复关联，不能换 ID 重下。
- OpenBB 公司于 **2026-10-01** 公布业务收尾和开源/治理迁移；Workspace 代码计划由 FINOS 承接，OpenBQ 承接相关资产。EqoBoard 将 OpenBB 作为可替换研究入口，主交易终端不依赖其托管服务。

## 验证

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/openterminal
npm ci
npm run build -w server
npm run test -w server
npx tsc --noEmit -p web/tsconfig.json
npm run build -w web
```

安全、BrokerAdapter、行情与演进说明见 `docs/` 与 `.agents/skills/`。
