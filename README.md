# EqoBoard

可二次开发的美股股票 + 期权终端。默认主 UI 复用 **OpenTerminal** 的 MIT Workspace/Widget/Chart 体系；期权链使用 **AG Grid Community**；生产美股/期权数据路径通过 Rust Gateway 请求 Alpaca **SIP/OPRA**。可选 OpenBB Lite 研究工作台由独立 Research BFF 和受控入口提供，不替代主终端。

## 核心组合

| 层 | 采用组件 | 责任与边界 |
|---|---|---|
| 1 · UI | OpenTerminal 主 Workspace；可选 OpenBB Lite 原生 Workspace | 主终端为默认 UI；研究工作台通过单独 Research origin 与 Compose `openbb` profile 启用 |
| 2 · 身份与 BFF | 两个独立 Next BFF + OIDC | 各自校验会话；Research BFF 只签最长 60 秒 `market:read` 委托，Lite 仍使用原生邮箱/密码登录，不构成 SSO |
| 3 · 行情契约 | Rust + Tokio + Axum Gateway | SIP/OPRA REST/WS、50ms 批处理、订阅租约、来源与时间戳；浏览器不直连券商数据 API |
| 4 · 市场来源 | Alpaca SIP / OPRA | 生产市场来源边界；覆盖数据 endpoint 的测试 fixture 只模拟 SIP/OPRA 协议，Gateway 必须标 `source=unknown` |
| 5 · 执行 | Rust BrokerAdapter | 唯一订单执行边界；当前 effective mode 固定为 disabled，Paper 与 Live 均不提交 |

系统五层关系：**OpenTerminal 主终端 + 可选 OpenBB Lite → 分离的 OIDC/BFF → Rust Gateway 行情契约 → Alpaca SIP/OPRA 市场来源；订单只能经 BrokerAdapter，当前保持 disabled。** AG Grid Community 用于期权链与 OpenBB Community 组合；OpenTerminal Lightweight Charts / Recharts 负责终端图表。

**EqoBoard = OpenTerminal Trading Terminal + OpenBB Research Workspace + AG Grid Options + Rust SIP/OPRA Gateway + BrokerAdapter Execution Layer**

OpenTerminal 原始代码保留在 `apps/openterminal`，上游许可与固定提交见 [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)。旧的自研 Vite 终端已退出仓库，防止两套 UI 长期分叉。

共享 Rust 市场契约固定复用 `trading-core/market-contracts`；`crates/domain` 仅为现有 EqoBoard 消费者保留旧 JSON DTO 的兼容重导出。旧 DTO 中的 `f64` 字段仅用于兼容展示，不是精确十进制 wire 或归档合同。

OpenBB manifests 和行情兼容路由位于 `apps/gateway/openbb/` 与 Rust Gateway；研究模式 Next BFF 通过独立 hostname、host-only OIDC cookies 和 `market:read` 短时委托访问它们。不同端口仍共享 hostname Cookie 边界。可选服务由默认 Compose 自动包含的 `openbb` profile 与原生 OpenTerminal Research 入口提供。无 skip 的 Compose + native Lite 浏览器生命周期验收已通过，测试使用真实 Rust Gateway 和仅测试用 loopback SIP/OPRA 协议 mock；mock 行的来源为 `unknown`，不代表真实 Alpaca entitlement 或市场数据。

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

同时将 `EQO_PUBLIC_ORIGIN` 与 `NEXTAUTH_URL` 设为浏览器访问的同一个 HTTPS origin，并在 OIDC 客户端登记 `${EQO_PUBLIC_ORIGIN}/api/auth/callback/eqo-oidc`。本机开发允许 loopback HTTP。OpenBB research runtime 还需设置 `EQO_TERMINAL_PUBLIC_ORIGIN`，并确保其 hostname 与研究 hostname 不同。Alpaca SIP/OPRA 凭据是可选的服务端变量；没有凭据时行情不可用，不会回退到其他来源。配置项和权限要求见 [部署说明](docs/DEPLOYMENT.md)。

运行：

```bash
docker compose up --build
```

需要启用可选研究工作台时，按 [部署说明](docs/DEPLOYMENT.md) 配置独立 research OIDC/session secrets、管理员凭据与不同 hostname 的公开 origin，然后执行：

```bash
docker compose --profile openbb build
docker compose --profile openbb up --build --wait
```

Research 入口默认绑定本机 `127.0.0.1:8088`。关闭该 profile 不影响 OpenTerminal、Gateway 或现有 Node research 服务。

入口：

- `http://localhost:3000`：OpenTerminal 主终端（与本地 `EQO_PUBLIC_ORIGIN` / `NEXTAUTH_URL` 配置一致；研究入口必须使用不同 hostname）。
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
- `/api/quotes` 与美股 `/api/history/:symbol` 只把美国上市股票/ETF发往 Rust SIP；VIX、已支持 crypto、海外挂牌后缀继续走对应研究 Provider。SIP 失败显式返回，不回退到 Yahoo 等来源。OpenBB Gateway 行情路由仍要求 Gateway 委托身份；隔离 Research BFF 只放行 `market:read`，不持有终端签名密钥、Node API key 或 Alpaca 市场凭据。当前真实浏览器矩阵使用受控 mock SIP/OPRA 请求，来源标记为 unknown，不能替代真实 Alpaca 行情账户验证。
- 登录配置缺失时页面会显示身份服务不可用，受保护 BFF 不向下游发请求。`/healthz` 是进程存活检查；`/readyz` 的身份就绪不代表 SIP/OPRA entitlement 或行情已就绪。
- OpenTerminal 可选 Engine Preview widget 只读取 trading-engine 的离线 status/preview；source 保持 unknown，execution 与订单变更保持 disabled。该预览需要专用 OIDC role 与同网络命名空间 loopback Engine，不代表真实账户、行情、风险或交易权限。
- 订单预览是离线风险检查，并绑定验证后的 OIDC `(issuer, subject)`；Paper submit 当前始终 blocked，Live 始终拒绝。Gateway status 将 adapter endpoint 配置和券商执行 capability 分开报告，Alpaca/IBKR/Schwab 的 Paper 和 Live capability 均 disabled；持久 preview/outbox、账户身份和真实 broker Paper 能力完成前不会开放提交。超时结果为 `UNKNOWN` 时保留 `client_order_id` 和原 preview 恢复关联，不能换 ID 重下。
- OpenBB 公司于 **2026-10-01** 公布业务收尾和开源/治理迁移；Workspace 代码计划由 FINOS 承接，OpenBQ 承接相关资产。EqoBoard 将 OpenBB 作为可替换研究入口，主交易终端不依赖其托管服务。

## GitHub Actions 与本地行情工具

公共 Actions 仅运行无私密凭据的 CI、CodeQL 和源码供应链检查。真实 Alpaca 只读 smoke、配额诊断、历史 QQQ SIP 导出及专用 App 自动合并均不由 Actions 执行；对应 workflows 已从 `.github/workflows` 移除，行情脚本保留为本地入口，专用 App 自动合并当前未启用。操作者若获准，可在隔离的本机进程中显式运行这些只读脚本；输出可能受行情许可约束，必须保存在仓库之外，不能提交或上传公开 artifact。入口和限制见 [安全边界](docs/SECURITY.md)、[部署说明](docs/DEPLOYMENT.md) 与 [PR 合并治理](docs/AUTOMERGE.md)。

## 交付矩阵与当前验收状态

| 范围 | 当前状态 |
|---|---|
| 可选 OpenBB profile、Research 导航、受控 ingress 与原生 Workspace | attempt-22 无 skip 默认 Compose、登录、三 Widget 和故障/恢复浏览器生命周期均通过 |
| SIP/OPRA 行情来源 | Gateway contract 和原生 Widget 使用 loopback 协议 mock 验证；source=`unknown`，真实 Alpaca entitlement/行情未验证 |
| 离线、恢复、停 OpenBB、故障升级与回滚 | attempt-22 验证 Gateway offline/restart、OpenBB 停服时主终端可用、坏镜像 unhealthy、原归档恢复、cleanup |
| Paper / Live | BrokerAdapter 仍 disabled；没有提交订单 |
| 集成分支 | PR #29 已由 owner 在非作者最终 diff 复核和 8/8 当前 head 检查通过后合并；merge commit 为 `e1b73c1347ce79d9b86d4e4fe3d1c5942b20ab97`，交易仍 disabled |

测试行使用协议 mock 且 `source=unknown`，未验证真实 Alpaca entitlement，也没有下单。[本地验收记录](docs/evidence/openbb-local-runtime-acceptance.json)绑定冻结代码、Compose 镜像 archive、OCI descriptors 和 runtime SBOM；release gate 仍未批准。完整构建与回滚说明见 [OpenBB supply-chain runbook](docs/OPENBB_SUPPLY_CHAIN.md)；本地 tag 或 daemon RepoDigest 观察都不表示 registry 发布。

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

安全、BrokerAdapter、行情与演进说明见 `docs/` 与 `.agents/skills/`。Owner 自合并授权与自动合并 App 的边界、检查要求和当前验收状态见 [PR 合并与自动合并治理](docs/AUTOMERGE.md)。
