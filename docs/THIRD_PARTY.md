# Third-party foundations

## OpenTerminal

- Repository: https://github.com/ErTasselli/OpenTerminal
- Imported baseline: `aed097c680cd8ec1c391ae06966babe7d6d91fc6`
- License: MIT
- Location: `apps/openterminal`

EqoBoard 保留其 Workspace、widgets、charts、research provider 和状态管理代码。差异代码集中于 EqoBoard 数据适配、AG Grid 期权、SSE、交易预览等文件。升级时先比较固定 SHA，再同步必要上游变化。

## AG Grid Community

- Version: 36.2.0
- License: MIT
- 用途：Option Chain 高频表格。Enterprise 特性不得在未取得许可时启用。

## OpenBB Workspace

- Spec/docs: https://docs.openbb.co/workspace/developers/data-integration
- Backend examples: https://github.com/OpenBB-finance/backends-for-openbb
- EqoBoard integration: `apps/gateway/openbb/widgets.json`、`apps/gateway/openbb/apps.json`
- Workspace source repository在 2026-10-01 已归档；OpenBB 官方同日公布公司业务收尾、OpenBQ 资产承接和 Workspace/FINOS 治理计划。

因此 OpenBB connector 保持松耦合，Rust API 才是稳定数据契约。未来 Workspace/OpenBQ/FINOS spec 变化只影响兼容层。

## 版本锁

机器可读版本记录见 `third_party/upstreams.lock.json`；CI 会验证 OpenTerminal SHA、MIT 许可、AG Grid 版本、OpenBB Workspace Apache-2.0 基线和已归档状态。
