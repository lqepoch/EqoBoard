# EqoBoard

可二次开发的美股股票 + 期权终端。默认本地 UI 直接复用 **OpenTerminal** 的 MIT Workspace/Widget/Chart 体系；期权链使用 **AG Grid Community**；市场数据统一由 Rust/Tokio 网关读取 Alpaca Plus 的股票 **SIP** 与期权 **OPRA**；**OpenBB Workspace** 通过同一 Rust 后端作为研究/AI 第二工作台。

## 核心组合

| 层 | 采用组件 | EqoBoard 扩展 |
|---|---|---|
| 主终端 | OpenTerminal @ pinned upstream commit | SIP/OPRA 路由、AG Grid Option Chain、IV Skew、OPRA Tape、Vertical Spread |
| 表格 | AG Grid Community 36.2 | 高频 async transaction、双边期权链 |
| 图表 | OpenTerminal Lightweight Charts + Recharts | Alpaca SIP K线、OPRA IV |
| 行情 | Rust + Tokio + Axum | SIP/OPRA REST/WS、50ms 批处理、租约、来源/时间戳 |
| 研究工作台 | OpenBB Workspace custom backend | widgets.json、apps.json、SIP/OPRA 表格 |
| 执行 | Rust BrokerAdapter | Alpaca / IBKR / Schwab；disabled → paper，live 拒绝 |

OpenTerminal 原始代码保留在 `apps/openterminal`，上游许可与固定提交见 [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)。旧的自研 Vite 终端已退出仓库，防止两套 UI 长期分叉。

## 启动

复制 `.env.example` 为 `.env`，填写：

```bash
ALPACA_KEY=...
ALPACA_SECRET=...
EQO_ACCESS_TOKEN=请使用强随机值
```

运行：

```bash
docker compose up --build
```

入口：

- `http://127.0.0.1:3000`：OpenTerminal 主终端。
- `http://127.0.0.1:8080`：Rust API / OpenBB Workspace backend。
- OpenBB Workspace 添加 Data Connector 时填 Rust backend URL，并配置 `Authorization: Bearer <EQO_ACCESS_TOKEN>`。

本地开发：

```bash
cargo run -p eqo-gateway
cd apps/openterminal
npm ci
EQO_RUST_URL=http://127.0.0.1:8080 npm run dev
```

## 当前边界

- 股票关键行情固定请求 SIP，期权关键行情固定请求 OPRA；401/403/429 原样转为显式状态，不做隐藏回退。
- OpenTerminal 的 FRED、SEC、FINRA、新闻、宏观等研究 Provider 保留；股票/期权价格与历史图表通过 EqoBoard Rust Gateway。
- 订单默认关闭。只有 `EQO_EXECUTION_MODE=paper` 且对应 Rust broker service 配置完成时，Paper 两腿流程才可进入确认阶段。
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
