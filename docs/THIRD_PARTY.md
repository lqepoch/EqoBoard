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
- OpenBB Workspace source repository 已归档。`bash tools/openbb/fetch-upstream.sh` 只获取锁定 SHA；`bash tools/openbb/source-sbom.sh` 输出 SPDX 2.3 **source archive SBOM**，`bash tools/openbb/patched-source-sbom.sh` 输出单独的锁定 Community patch 后 source SBOM。两者均使用 `tools/openbb/toolchain.lock.json` 中固定版本和归档 SHA 的 Syft；缓存二进制每次执行前都从已校验 release archive 原子恢复。扫描选择全部 package catalogers、固定 `--parallelism 1`、关闭扫描缓存、纳入 JavaScript dev dependencies，并连续扫描 3 次；规范化 package name/version 集合或 SPDX package 条目数变化时以 `SBOM_UNVERIFIED` 失败关闭。该 SBOM 描述源码依赖，不代表已构建镜像；包数量不能证明浏览器集成。
- Community patch 使用真正的 OpenBB Lite Workspace，不另写 React 终端。它移除 AG Grid/Charts Enterprise 注册、Highcharts 依赖和不适用于 Community 的表格集成菜单，并对不可用的 Enterprise-only widget 显示显式状态。AG Grid 从上游锁定的 34.1.1 调整至 Community 36.2.0，以满足本项目 OpenBB Community 组合目标；36.2.0 同时要求 `ag-charts-types@14.2.0`，保留 OpenBB 的 Charts 12.1.1 会安装两套不兼容类型，并导致 `AgChartFromTable` / `OmniWidget` 的 TypeScript 类型错误。因此 AG Charts Community/React/types 一并固定到 14.2.0。主终端的 AG Grid 36.2.0 与 OpenBB 的版本记录仍彼此独立。
- 旧本地候选的浏览器 attempt 03 触发 API 500：Bookworm 镜像的 SQLite 3.40 尚无内置 `concat()`，而上游用户名查询使用了该函数。锁定 Community patch 改用 SQLAlchemy 字符串表达式（SQLite/PostgreSQL 使用 `||`，MySQL 保留 `concat()`），并在 Docker Cython 编译前运行 SQLite 回归；它还删除 `terminalpro/index.html` 中未被 Lite 使用的 UDF 脚本注册行。当前 build identity 为 `cfc03fb056e7c60226186f332d2dc7bf7eb6d30acd3de342fc7b7bb5efc77d47`。先前 09028 identity 的 r4 候选已完成 SQLite 3/3 回归、容器健康探测和 OCI 导入回滚 smoke，但它没有包含该最新 UDF 行删除，不能作为当前锁身份的镜像证据。
- 当前 build gate 是 `local-buildable`：仅表示锁定 source + 单一 community patch + Dockerfile 检查允许尝试本地构建。构建门验证 lock 与 Dockerfile 实际复制、执行相同 runner、patch、manifest；增加 patch 必须显式更新该契约。`bash tools/openbb/build-lite.sh` 会校验支持文件 SHA，独立检查 patched source findings，并使用锁定 recipe；CI drift 报告逐文件列出 exact、modified、EqoBoard-only、deleted upstream 文件。Dockerfile 内的 BuildKit `ADD --checksum` 仍会校验固定归档。静态检查是有限策略，不是通用 Dockerfile 安全证明。此状态不代表 Docker 镜像构建成功、镜像健康、Research 登录或浏览器 E2E 通过，也不批准部署；这些状态分别记录为未验证/未运行/未批准。
- Recipe 使用 digest 固定的基础镜像与冻结 Bun lock，Poetry 要求与已锁 `poetry.lock` 一致且没有自动重解锁回退。但 Debian APT 索引/包字节未使用仓库快照锁定，pip 引导包只有版本 pin 而无逐包 hash，前端上游 webfont 构建会下载未单独 hash 锁定的字体；因此不宣称 bit-for-bit 可复现。`build-lite` 在 owner-private XDG cache 中按完整 build identity 与 local image tag 加文件锁，同一用户的不同 worktree 共享该互斥；手动 Docker 或 Compose 不参与。Build record 文件名包含完整 identity，且拒绝覆盖旧记录。Compose tag 只用于本地构建证据；发布/部署必须记录真实 OCI manifest digest 或 registry RepoDigest、OCI archive digest 和对应 build record，不得把本地 image config ID 冒充 registry digest。
- BuildLite 记录包含本地 image ID、独立 runtime image SPDX SBOM 和 patched-source SBOM；Vite runtime 只有编译后 `dist`，没有 Bun/npm package metadata，因此镜像扫描不能覆盖或识别完整前端锁依赖。使用 patched-source SPDX 清单补充前端依赖，但两份 SBOM 作用域不得互相替代。当前 `cfc03f…` identity 的 Community Lite r5 与 `build-lite.sh` helper image 有独立的 BuildKit、SBOM 和 OCI 记录；r5 OCI archive SHA-256 为 `0788b28c51b6cbaf1a60304ecfabcd3f9561929a8e58db7ffcd0b24eb9bc897b`，本地 OCI index 为 `sha256:ddbba735d45c565866a5f694ac46ff1ea1b78e9574ecbdc1082739f09238e261`。attempt-22 又对实际 Compose-build image 单独导出 archive、验证 OCI index/manifest/config/layers，并用锁定 Syft 1.54.1 生成 326 entries / 314 package identities 的稳定 runtime SBOM；两个 image 的身份不得混用。完整 hash 与 browser evidence 见 `docs/OPENBB_SUPPLY_CHAIN.md`。两者都只是本地构建与回滚记录，不代表 registry 发布或部署批准；锁文件中的 release `image_digest` 仍为空。
- 源码 NOTICE 表明 TradingView Advanced Charts 是专有库，未包含在归档中；Lite 默认构建关闭该本地库，但 upstream 仍存在 TradingView 远程嵌入 Widget。Highcharts、AG Grid Enterprise、AG Charts Enterprise 的权利不由 OpenBB 根目录 Apache-2.0 LICENSE 扩大。

因此 OpenBB connector 保持松耦合，Rust API 才是稳定数据契约。只读源归档、许可证、Community source patch 和 recipe 已锁定。attempt-22 已对当前 identity 完成默认 Compose profile build/up、native Lite 三 Widget 浏览器 E2E、core-only 可用性、Gateway offline/restart、实际故障镜像检测与归档回滚，并为 Compose-built image 独立生成运行镜像 SBOM。测试只模拟 SIP/OPRA wire protocol，Gateway 对覆盖上游 endpoint 的数据标为 `unknown`；不能拿这些行证明 Alpaca entitlement 或真实 SIP/OPRA 行情。没有 registry 发布、部署或订单执行；每个新 build identity 仍须单独关联 Compose image archive、SBOM、启动、浏览器与回滚证据。未来 Workspace/OpenBB/FINOS spec 变化只影响兼容层。

OpenBB 上游差异报告、许可证检查和镜像回滚流程见 [`docs/OPENBB_SUPPLY_CHAIN.md`](OPENBB_SUPPLY_CHAIN.md)。

## Shared Rust market contracts

- Repository: https://github.com/lqepoch/trading-core
- Crate: `market-contracts`
- Pinned revision: `0a2eaff08d45e8abc1a0137dab17d5d3ef5553c8`
- Declared license: `MIT OR Apache-2.0`
- EqoBoard usage: `crates/domain` re-exports the pinned crate's `legacy` module to preserve existing `eqo_domain::*` consumers and JSON shape. New versioned market wire contracts should use the shared crate directly; legacy `f64` DTOs are not exact-decimal archival contracts.

The same repository also publishes the npm Git package `@lqepoch/trading-core-contracts`. OpenTerminal pins it to `290fff0cbc743928d6a7f12ac4b958b08cdff686` in `apps/openterminal/web/package.json` and `package-lock.json`; the declared license is `MIT OR Apache-2.0`. The Quant BFF uses its `parsePredictionEnvelopeProtoJsonText` parser for bounded public ProtoJSON, including duplicate-key, alias, unknown-field, uint64-string, and raw-frame encoding checks. The browser receives only the public projection after this server-side validation.

## Rust JWT and trust-root data

- `jsonwebtoken` is pinned to `10.3.0` in `Cargo.lock`, with `default-features = false` and only its `aws_lc_rs` crypto backend enabled in `apps/gateway/Cargo.toml`. This avoids resolving the unpatched `rsa` crate through `rust_crypto`; it does not imply that other crypto dependencies are advisory-free.
- Current locked backend versions are `aws-lc-rs 1.18.1` and `aws-lc-sys 0.45.0`. The dependency graph and licenses are checked with `cargo deny check all`; the exact Git source allowlist is limited to the pinned `lqepoch/trading-core` revision and crates.io.
- `webpki-roots 0.26.11` and `webpki-roots 1.0.9` contain trust-root data under CDLA-Permissive-2.0. Their packaged `LICENSE` files have the same SHA-256, `e271993808fec50ab29350b39539cdec611a9103f827e0aa26d61da70e2d33f8`. The exact text is retained at `third_party/licenses/webpki-roots/CDLA-Permissive-2.0.txt` and copied into the Gateway runtime image under `/usr/share/licenses/eqoboard/` so it accompanies the distributed trust-root data.
- `deny.toml` explicitly allows only the observed permissive SPDX identifiers and scopes CDLA-Permissive-2.0 exceptions to those two exact crate versions. Unknown licenses, unpinned Git sources, yanked packages, and known advisories fail the check; the policy contains no advisory ignores.

## 版本锁

机器可读版本记录见 `third_party/upstreams.lock.json`。OpenTerminal、AG Grid Community 和 OpenBB 的固定版本及许可证副本由 `tests/test_upstream_provenance.py`、`tests/test_openbb_supply_chain.py` 和 `tools/openbb/verify-upstream.sh` 校验；Rust shared contracts 通过 `Cargo.toml` 和 `Cargo.lock` 固定 Git revision。`market-contracts` CI 校验固定 OpenBB archive、许可证及 Syft 二进制 SHA，上传 upstream source SBOM、patched-source SBOM 与逐文件 upstream drift 报告；该 job 不构建镜像或证明浏览器集成。升级必须经显式 PR 更新 source commit、归档 SHA、许可证副本、community patch、SBOM、drift report 和 build record；禁止跟踪 upstream 分支。

- 2026-10-08 OpenTerminal security refresh：`apps/openterminal/package-lock.json` 锁定 Next.js 15.5.27、PostCSS 8.5.28 override、fast-xml-parser 5.7.0、Vitest 4.1.11 / Vite 6.4.3，以及修补版 proxy-addr、sharp、shell-quote、source-map-js。`npm audit --package-lock-only --audit-level=low` 在锁刷新时报告 0 个已知漏洞；升级日志和测试结果以对应 PR 为准，后续发布仍须重新审计。
