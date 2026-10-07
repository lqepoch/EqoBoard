# EqoBoard

**美股股票 + 期权专业终端｜OpenTerminal + AG Grid + OpenBB Workspace + Rust**

EqoBoard 复用成熟金融终端能力，主 UI 运行固定上游版本的 **OpenTerminal Next.js Workspace**；期权链使用 **AG Grid Community**；Rust/Tokio/Axum 网关统一读取 Alpaca Plus **SIP / OPRA** 并承载交易适配边界；**OpenBB Workspace** 通过官方 Custom Backend 协议连接同一 Rust 数据契约。

## 架构

| 层 | 基础组件 | EqoBoard 差异能力 |
|---|---|---|
| 主终端 | OpenTerminal @ `aed097c...` | Alpaca server-side adapter、AG Grid OPRA、IV Skew、OPRA Tape、Vertical Spread |
| 表格 | AG Grid Community 36.2.0 | Call/Put 双边链、50ms batch、async transaction |
| 图表 | OpenTerminal Lightweight Charts / Recharts | SIP K线、OPRA IV |
| 数据网关 | Rust + Tokio + Axum | SIP/OPRA、来源/时间戳、租约、鉴权、SSE/WS |
| 研究工作台 | OpenBB Workspace Custom Backend | `widgets.json` / `apps.json` / `openbb/v1/*` |
| 执行 | Rust BrokerAdapter | Alpaca / IBKR / Schwab，默认 disabled，Paper 需显式开启 |

上游版本、许可证和同步边界见 `docs/UPSTREAM_SOURCES.md` 与 `third_party/upstreams.lock.json`。

## 启动

复制 `.env.example` 为 `.env`，至少配置：

```bash
ALPACA_KEY=...
ALPACA_SECRET=...
EQO_ACCESS_TOKEN=strong-random-secret
```

运行：

```bash
docker compose up --build
```

- `http://127.0.0.1:3000`：OpenTerminal 主终端。
- `http://127.0.0.1:8080`：Rust Gateway 与 OpenBB Custom Backend。
- OpenBB 自托管 Workspace 按 `integrations/openbb/README.md` 添加 Data Connector。

开发模式：

```bash
cargo run -p eqo-gateway

cd apps/openterminal
npm ci
EQO_RUST_URL=http://127.0.0.1:8080 \
EQO_ACCESS_TOKEN="$EQO_ACCESS_TOKEN" \
npm run dev
```

## 数据规则

- 股票关键行情固定请求 SIP；期权关键行情固定请求 OPRA。401/403/429 显式暴露，行情源不会静默替换。
- OpenTerminal 自带的 FRED、SEC、FINRA、新闻、宏观 Provider 保留作补充研究；核心股票/期权 Quote、K线、Option Chain 经 Next server-side adapter 进入 Rust。
- OPRA IV/Greeks 是快照字段，合约并非同一时刻采集；空字段保持空。
- 2026-10-07 的组织 Secrets 在线检查显示当前 SIP/OPRA 实时权限返回 HTTP 403；需在 Alpaca 账号侧核对 Plus entitlement。历史 SIP 可用不代表实时授权。
- 订单执行默认为 `disabled`。Paper 也经过一次性 Preview、限额、原子多腿校验、审计、幂等和外部 Rust BrokerAdapter 二次检查。

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

OpenBB：`integrations/openbb`。架构：`docs/ARCHITECTURE.md`。执行契约：`docs/ADAPTER_CONTRACT.md`。安全：`docs/SECURITY.md`。
