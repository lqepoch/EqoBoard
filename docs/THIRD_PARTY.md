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
- 固定 source：`OpenBB-finance/workspace@be00e95019a55d57af146919ee46b7e1a4859226`。
- GitHub codeload tar.gz SHA-256：`4171aa8984c7c63e171239f8cda72c4bc950f1e068de33577035dc8e5d63e6a4`。
- 仓库 Apache-2.0 原文与 NOTICE 副本及 SHA-256：`third_party/licenses/openbb-workspace/`；源归档和副本由 `bash tools/openbb/verify-upstream.sh` 校验。
- OpenBB Workspace source repository 已归档。`bash tools/openbb/fetch-upstream.sh` 只获取锁定 SHA；`bash tools/openbb/source-sbom.sh` 使用 `tools/openbb/toolchain.lock.json` 中固定版本和归档 SHA 的 Syft 输出 SPDX 2.3 **source archive SBOM** 到 `build/openbb/`。Syft 缓存二进制每次执行前都从已校验 release archive 原子恢复。该 SBOM 描述源码清单和锁文件依赖，不代表已构建镜像。
- `docker buildx` 镜像构建当前由显式 build gate 阻断。该 commit 的 Lite Dockerfile 使用 `ag-grid-enterprise@34.1.1`、`ag-charts-enterprise@12.1.1` 并无条件注册 Enterprise 模块，`main.tsx` 还嵌入只授予 OpenBB-Pro 的 Enterprise key；前端也含需单独许可审查的 Highcharts 包。官方 Lite Dockerfile 引用缺失的 `terminalpro/package-lock.json`，其源码只有 `bun.lock`，且 Poetry 锁不一致时会静默重解锁；基础镜像也使用可变 tag。不能仅隐藏 Enterprise 标签后分发，也不能把 source SBOM 写成镜像 SBOM。
- `bash tools/openbb/build-lite.sh` 会在任何下载/构建之前检查此 build gate。只有显式审查并更新锁文件中的 build 状态、证据和带 SHA-256 的构建 recipe，且 source 扫描不再发现商业组件/锁文件/镜像固定问题后才会构建。社区 recipe、patch runner、patch 和辅助文件均需单独锁 SHA-256；构建上下文重新带入已验源归档，Dockerfile 还必须独立校验归档 SHA。静态检查只接受归档 `COPY` 到绝对路径并由单条 canonical `RUN echo '<locked SHA>  <same path>' | sha256sum -c -` 校验，或使用锁定 URL/SHA 的 `ADD --checksum`；显式 `SHELL` 覆盖会被拒绝。这是有限的静态策略检查，不是通用 Dockerfile 安全证明，真正构建阶段仍会执行归档校验。默认 tag 由 source commit、recipe、variant 和支持文件摘要生成；命令拒绝非匹配 tag，并拒绝覆盖任何已有本地 tag。成功时生成镜像 ID、镜像 SPDX SBOM 和 build record。当前部署 digest/SBOM 均为空，不能报告为已集成或可部署。
- OpenBB 固定前端自身声明 `ag-grid-community` / `ag-grid-enterprise` `34.1.1` 和 AG Charts `12.1.1`。EqoBoard 主终端的 AG Grid Community 版本仍固定为 `36.2.0`；不能把主终端版本套用到 OpenBB，也不能不审查地升级 OpenBB 依赖。
- 源码 NOTICE 表明 TradingView Advanced Charts 是专有库，未包含在归档中；Lite 默认构建关闭该本地库，但 upstream 仍存在 TradingView 远程嵌入 Widget。Highcharts、AG Grid Enterprise、AG Charts Enterprise 的权利不由 OpenBB 根目录 Apache-2.0 LICENSE 扩大。

因此 OpenBB connector 保持松耦合，Rust API 才是稳定数据契约。当前只核验了固定 source 和 Apache 许可证材料；真正的 Lite 镜像构建、Compose 启动、浏览器连接及 SIP/OPRA Widget E2E 尚未完成。未来 Workspace/OpenBQ/FINOS spec 变化只影响兼容层。

## 版本锁

机器可读版本记录见 `third_party/upstreams.lock.json`。OpenTerminal、AG Grid Community 和 OpenBB 的固定版本及许可证副本由 `tests/test_upstream_provenance.py`、`tests/test_openbb_supply_chain.py` 和 `tools/openbb/verify-upstream.sh` 校验。升级必须经显式 PR 更新 source commit、归档 SHA、许可证副本、SBOM 和构建审查记录；禁止跟踪 upstream 分支。
