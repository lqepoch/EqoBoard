# OpenBB Workspace 官方 Custom Backend 接入

本目录包含 **实际可由 OpenBB Workspace 读取** 的 widgets.json / apps.json。
Rust Gateway 在 GET /widgets.json、GET /apps.json 暴露配置，在以下只读接口提供真实股票/期权数据：

- GET /openbb/v1/stocks?symbols=SPY,QQQ — Alpaca SIP snapshots
- GET /openbb/v1/bars?symbol=QQQ&timeframe=1Min — Alpaca SIP OHLCV
- GET /openbb/v1/options?underlying=QQQ&expiration=2026-10-09 — Alpaca OPRA contract snapshot

打开或自托管上游 OpenBB Workspace Lite（2026-10-01 Apache-2.0 开源仓库），Data Connectors → Add Data，输入 EqoBoard Gateway 地址，配置 Authorization Bearer Header（当 EQO_ACCESS_TOKEN 非空）。

## 关键鉴权和网络

EQO_BIND 默认 127.0.0.1；跨进程容器需使用私网 HTTPS/反向代理，不可直接暴露公网上的行情和登录口。
自托管 OpenBB Lite 地址如 http://127.0.0.1:3000，跨域访问时设置 EQO_OPENBB_ALLOWED_ORIGIN=http://127.0.0.1:3000（仅该 Origin 可读取；通配符被拒绝）。非环回 Origin 必须 HTTPS。
OpenBB 连接配置只保存 EqoBoard 网关专用 Access Token，不填写 ALPACA_KEY 或 ALPACA_SECRET。
浏览器从 HTTPS Workspace 发往 HTTP localhost 可能被 Mixed Content / Private Network Access 阻断；最佳部署是同私有网络自托管 OpenBB，使用 HTTPS 且严格 Origin 与 OIDC 策略。

OpenBB 源码在 2026-10-01 已归档，Lite 镜像、后续安全修复和维护主体需再次核验。不在 EqoBoard 核心构建中隐式拉取未锁定的 openbb/lite:latest。

## 语义与边界

Stock/Options 都保持真实 SIP/OPRA feed 标识，权限不足必须返回 HTTP 403。Options expiration 未指定时展示接下来最近的周五，节假日或是否有该期权系列需要按交易所日历核对。
该桥接属于 OpenBB 只读 Table Widget；尚未实现其 live_grid 专用 WS 协议、AI/MCP、订单/账户访问。含 truncated 标志，绝不制造 Open Interest/GEX。

源文档：https://docs.openbb.co/workspace/developers/data-integration
上游源码：https://github.com/OpenBB-finance/workspace

Widget `source` 字段按 OpenBB 官方 widgets.json Reference 采用字符串数组，`refetchInterval=15000` 配置 15 秒轮询；真正 tick 实时链仍由原生 EqoBoard AG Grid WebSocket 展示。
