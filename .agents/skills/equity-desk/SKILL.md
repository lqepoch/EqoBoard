---
name: equity-desk
description: 维护 apps/desk 本地股票与期权行情台：富途 OpenD 报价/逐笔/摆盘、yfinance 摘要、Alpaca 历史与期权、秒级本地缓存与 Futu 风格界面。
---
# 本地行情台（equity-desk）

先阅读 `apps/desk/AGENTS.md`，它是这个目录的权威需求说明。用户的明确要求优先于根 `AGENTS.md` 与原生终端 Skill（见该文件"优先级"一节）。

## 适用范围

- `apps/desk/src/**`：服务端（富途适配、缓存、Alpaca 历史与期权、yfinance、HTTP 路由）。
- `apps/desk/public/**`：界面（图表、自选、逐笔、摆盘、期权链）。
- 不适用于原生终端 `apps/eqoboard-web` 的 Widget SDK 与 Gateway 契约；那些仍按 `native-terminal` Skill 执行。

## 工作步骤

1. 读 `apps/desk/AGENTS.md`，确认数据源、缓存窗口与界面规则。
2. 改服务端时，检查密钥只从根 `.env` 读取，不输出值；`/api/*` 响应不包含密钥。
3. 改数据语义（周期、聚合、缓存、标注）时，同时更新 `apps/desk/AGENTS.md` 与 `docs/MARKET_SOURCES.md`。
4. 语法检查：`node --check` 检查 `src/*.mjs` 与 `public/app.js`，使用仓库内 Node 22.23.3。
5. 启动或重启：`DESK_PORT=3000 <node.exe> --env-file-if-exists=../../.env src/server.mjs`（在 `apps/desk` 下），只绑定 `127.0.0.1`。应用不读取 `.env` 文件，只读进程环境变量。
6. 核对接口（见 `apps/desk/AGENTS.md`"检查清单"），再核对页面数值。截图在该面板上可能被缩放，不能只凭截图判断布局。
7. 汇报时区分"已验证的真实数据"与"缺口"，缺失数值显示 `—`，不得用模拟值填充。

## 禁止

- 生成随机、合成或估算的行情、期权或摘要数值来充当数据。
- 把 Alpaca 指示性数据的延迟写成固定数字（如"15 分钟"）；延迟必须按报价时间实测。
- 把富途的成交方向字段翻译成"主动买/卖"。
- 把 IV、希腊字母等 Alpaca 不提供的字段显示为 0 或猜测值。
- 把 5 秒、10 秒直接从逐笔聚合；它们必须由 1 秒线推导。
- 让非连续竞价成交（零股 OddLot、均价 AvgPrice、附条件 Contingent 等）移动 K 线价格；只有通过跳价守护（`src/price-filter.mjs`）的 Automatch 成交移动价格。
