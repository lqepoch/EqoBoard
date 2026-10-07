# 上游组件复用与版本治理

## OpenTerminal

EqoBoard 运行 OpenTerminal 原生 Next.js Workspace，而非维护平行终端实现。

- 上游：`ErTasselli/OpenTerminal`
- 固定提交：`aed097c680cd8ec1c391ae06966babe7d6d91fc6`
- 许可证：MIT
- 下游：`apps/openterminal`
- 许可证副本：`third_party/OpenTerminal-LICENSE.txt`

保留 Workspace、Zustand store、Command Palette、Charts、Watchlist、Screener、Heatmap、Calendar、Macro、SEC/FINRA/News 等成熟模块。EqoBoard 差异限定在 Alpaca adapter、AG Grid Option Chain、IV Skew、OPRA Tape、Vertical Spread 和 server-side proxy。

上游同步流程：固定新 SHA → 比较差异 → 检查许可证/依赖 → 同步通用模块 → 保留 EqoBoard adapter → server test + TypeScript + Next build → 更新 lock 文件。

## AG Grid Community

- 版本：36.2.0
- 许可证：MIT
- 使用位置：`apps/openterminal/web/components/widgets/OptionsWidget.tsx`
- 用途：双边 Option Chain、虚拟化、排序/resize、`applyTransactionAsync` 增量更新。

## OpenBB Workspace

EqoBoard 继续使用主线已实现的官方 Custom Backend 协议：

- `integrations/openbb/widgets.json`
- `integrations/openbb/apps.json`
- Rust `/openbb/v1/*`

OpenBB 在 2026-10-01 进入开源与治理迁移阶段；该接口层保持可替换，Rust 数据模型和交易链不依赖 Workspace 内部实现。TradingView Advanced Charts 等受限资产不进入 EqoBoard。

## 数据治理

OpenTerminal research server 的免费公开 Provider 只用于研究补充。股票/期权交易视图固定经 Rust 请求 Alpaca SIP/OPRA。当前组织 Alpaca Secrets 于 2026-10-07 实测实时 SIP/OPRA 均返回 403，应用保持显式错误。

官方来源：
- https://github.com/ErTasselli/OpenTerminal
- https://github.com/OpenBB-finance/workspace
- https://docs.openbb.co/workspace/developers/data-integration
- https://www.ag-grid.com/react-data-grid/
- https://docs.alpaca.markets/us/reference/stockbarsingle-1
