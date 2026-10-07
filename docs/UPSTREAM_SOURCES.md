# 上游组件复用与版本治理

## 已集成的内容（以 2026-10-07 代码为准）

**OpenTerminal**：确实复用仓库源码。将 Widget registry/Zustand persist、全局代码联动、可拖拽 Workspace、快捷键、Command Palette 适配到 EqoBoard React/Vite 和 react-grid-layout v2。源码来自 ErTasselli/OpenTerminal，固定 commit aed097c680cd8ec1c391ae06966babe7d6d91fc6，MIT，附带原 LICENSE。改造位置 apps/web/src/upstream/openterminal。与上游代码有差异，并未完整复制其 Next.js 前端或免费行情源。

**AG Grid Community**：期权链仍直接使用 AG Grid 36.2.0（apps/web/src/components/OptionChain.tsx），含双向 Call/Put、增量交易异步 applyTransactionAsync、行复用、动态选中；独立 Rust 服务端负责 SIP/OPRA 和券商委托。

**OpenBB Workspace**：使用其官方 widgets.json / apps.json Custom Backend 协议，由 EqoBoard Rust Gateway 提供只读行情接口。可在自托管 OpenBB Lite 内当第二个数据分析界面使用。此仓没有复制整套 OpenBB Workspace 或运行其容器，请按 integrations/openbb/README.md 单独部署。

## OpenBB 2026-10-01 上游治理变化

OpenBB 2026-10-01 已宣布开源整个 Workspace，并归档 OpenBB-finance/workspace 主仓库。上游现为 Apache-2.0；OpenBQ 与 FINOS 将参与后续治理，工程版本、维护主体和发行供应链存在演进风险。EqoBoard 主交易终端依赖更小的 OpenTerminal 移植实现，OpenBB 为非关键、可切换的数据分析界面，防止单一交接期项目成为交易系统运行前提。

上游 OpenBB NOTICE 明确其 TradingView Advanced Charts 的专有库没有以 Apache-2.0 授权，并未随源码分发。EqoBoard 使用独立 Apache-2.0 Lightweight Charts 5.x。

## 安全与可维护性

仓库采用 third_party/upstreams.lock.json 锁定上游提交及许可证。每次同步必须先检查 License、NOTICE、供应链漏洞、升级变更日志、API/行为差异与适配测试；更新只能通过 PR、CI，并由独立维护者审核涉及认证、交易和分发的数据路径。

OpenTerminal 原工程依赖免费公共站点及回退链；EqoBoard 主行情禁止 Yahoo/IEX/indicative 回退。Alpaca Plus 现有组织 Key 2026-10-07 在线 SIP/OPRA 检查均返回 403（账号授权问题），系统保持 fail-closed。

## 官方来源

- OpenTerminal: https://github.com/ErTasselli/OpenTerminal
- OpenBB Workspace: https://github.com/OpenBB-finance/workspace
- OpenBB Lite: https://github.com/OpenBB-finance/workspace/tree/main/lite
- OpenBB Custom Backend: https://docs.openbb.co/workspace/developers/data-integration
- AG Grid: https://www.ag-grid.com/react-data-grid/
