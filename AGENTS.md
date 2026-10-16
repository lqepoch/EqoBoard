# EqoBoard Agent 工作约定

目标：优先复用成熟金融终端与组件，保持 SIP/OPRA 来源真实、交易失败关闭、接口可审计。

1. 新 UI 开发目标为独立 `apps/eqoboard-web`，使用原生 Workspace/Widget SDK 与共享行情总线。`apps/openterminal` 为受迁移基线保护的旧实现，保持可用与字节完整，默认只读；新增 UI 不再扩展旧运行时。生产默认部署在完整功能、安全、数据迁移、性能、容器与回滚验收通过前仍保留旧终端，禁止提前切换。
2. 期权大表统一使用 AG Grid Community；高频更新使用批量 transaction，禁止每个 tick 触发整表 React render。
3. OpenBB 位于 Rust Gateway 的兼容接口层：`/widgets.json`、`/apps.json`、`/openbb/*`。修改前核对当前官方 Workspace spec。
4. 共享市场契约由固定版本的 `trading-core/market-contracts` 提供；`crates/domain` 仅保留 EqoBoard 旧 JSON DTO 的兼容重导出。Alpaca 在 `crates/alpaca-data`，执行适配在 `crates/execution`，HTTP/WS 在 `apps/gateway`。旧 DTO 的 `f64` 字段不得作为精确行情归档或新 wire contract。
5. ALPACA_KEY / ALPACA_SECRET 只能进入服务端运行环境。公共 GitHub Actions 不读取组织行情、OAuth、Drive 或 GitHub App 凭据，也不执行真实行情探测、数据导出或自动合并；对应 workflows 已从 `.github/workflows` 移除，保留的只读行情脚本只能由操作者在本地显式运行，生成的数据不得提交或作为公开 Actions artifact。任何 mock 数据必须显式标识，不能伪装行情。
6. live 委托保持拒绝；当前 Gateway 的 effective execution 固定为 disabled，即使配置请求 Paper 也只保留只读和离线 preview。Paper 还需一次性服务端锁定 preview、限额、原子多腿、幂等、持久 outbox、账户身份、审计和对账后才可单独启用。
7. 上游依赖固定版本/commit，保留许可证和变更记录。第三方源码必须记录来源和许可证，不得宣称原创；OpenTerminal/OpenBB 是参考与可选来源，原生终端不得依赖其应用包或 Node Server。旧参考源码的删除、移动或修改需独立明确授权与审计；现阶段只读，不为修复编译而删旧文件。
8. 变更前阅读所属目录 AGENTS.md 和匹配的 `.agents/skills/**/SKILL.md`。
9. 原生终端浏览器只通过原生 Next BFF，旧终端继续使用其旧 BFF；可选研究工作台使用独立 hostname 的 research-mode Next BFF。两者都通过受信 OIDC issuer 建立会话；研究 BFF 只签发短时 `market:read` Gateway 委托，不配置终端签名 key、订单 scope 或市场凭据。`/api/research/auth-check` 只供内部反向代理做会话/market role 检查，不签 token，公共 ingress 必须隐藏此路径。不同端口不隔离 host-only cookies，Gateway 不信任身份头或静态 `EQO_ACCESS_TOKEN`。
10. Engine 离线预览只通过终端同源 BFF `/api/eqo/engine/{status,preview}`，仅受信 OIDC `eqoboard-engine-offline-reader` role 获得 `engine:offline-read`。终端 signer 使用独立 `ENGINE_TERMINAL_JWT_SECRET`、固定 `kid=engine-terminal` / `iss=eqoboard-openterminal` / `aud=lqepoch-trading-engine` / 字符串 scope `engine:offline-read`，期限不超过 60 秒；Research runtime 不配置 Engine URL/key，也不代理 Engine。只接受 `EQO_ENGINE_URL=http://127.0.0.1:<port>`，需与保持 loopback bind 的 Engine 共用 host/network namespace；缺配置时为 unavailable。状态与预览是分开的 best-effort synthetic 诊断读取，source 仍 unknown，不能表示一致快照、账户/市场已加载或任何交易权威。
11. 用户已明确授权本仓库 owner 自合并 PR；该持续授权适用于用户授权的本仓库开发任务及其 PR 范围，不逐任务或逐 PR 重复询问相同合并权限，也不覆盖未授权任务或其它仓库。owner 合并前必须确认 base 为最新远程 `main`、head SHA 已冻结、required-check 并集与 CodeQL 均在该 head 上成功、无冲突或 `CHANGES_REQUESTED`/未解决阻断 review/thread，并完成绑定最终 head 的 diff 自审且无阻断问题；作者可以自行完成审查，不强制等待非作者，自审记录必须标为 `SELF_REVIEW`，不得冒称独立复核。OpenBB 的 change-routing 与 aggregate gate 必须在当前 head 成功；仅在路由明确排除相应 OpenBB 重型验收且 aggregate gate 成功时，两个已登记、非 required 的 source/runtime guard 可为 `skipped`。两项 guard 必须存在并绑定同一 OpenBB workflow suite；任何 required check 或 CodeQL 缺失、失败、未知、过期，或规则要求重型 guard 时的 `skipped` 都阻止合并。owner 可使用仓库已有 Owner/Admin/Team 权限例外处理唯一剩余的形式审批门槛；这不是独立审查，也不得伪造 GitHub `APPROVED`。合并前以期望 head SHA 写入，合并后验证远程 `main`。核验后仅清理本任务干净的 worktree/branch；先检查 dirty 状态及私有 `.env`/`.state`，不删除其它任务的 worktree 或分支。专用 App 仍执行其自身独立审批策略。禁止为此降低组织 ruleset、绕过失败或未知检查、扩大其它仓库权限，或启用 Paper/Live 交易。
12. 可选模块必须与核心模块的 CI 验收隔离：核心 workflow 只执行核心检查；可选模块的源码、镜像构建、SBOM 和端到端检查使用独立 GitHub Actions workflow。稳定的 required gate 每次都运行；只有其路径路由确认无需 OpenBB 重验时才允许跳过重型 lane，共享运行时、身份、BFF、Gateway、契约、依赖、容器或测试基础设施改动必须触发相关重验。手动和计划运行执行完整 OpenBB 验收。开发者本地运行不构成 OpenBB CI、release 或部署验收证据。

当前职责边界：OpenTerminal/Next BFF 的行情与券商路径仅用于读取和离线预览；Rust Gateway 是过渡期市场数据/兼容服务，effective execution 固定为 `disabled`。九仓职责汇总仅是 [Draft PR #20 的治理候选](https://github.com/lqepoch/platform-ops/blob/codex/chg-2026-001-workspace-layout/docs/NINE-REPOSITORY-ARCHITECTURE.md)，未合入前不取代本仓源码、锁定依赖和本地文档作为当前行为依据。

本机授权例外及当前验收边界见 `docs/FUTU_LOCAL_MARKET_DATA.md`：显式 loopback 直开可授予市场、workspace、私有研究、订单预览和 Paper scope；行情可选 Futu、期权暂停，交易目标 Alpaca Paper。该例外不表示实际执行已启用；effective execution 仍 disabled，Live 拒绝，部署缺省仍为 OIDC。

12. 股票/ETF统一历史图表通过同源 BFF 与 Core Bars V1；`EQO_MDP_MARKET_BARS_ENABLED` 默认关闭，可回滚到旧历史路径。逐段保留 provider/feed/缺口和复权语义，source unknown 不可由路由意图替代。Futu 历史复用唯一 loopback OpenD 连接，无新订单或期权权限。
13. 公共仓库编译、build 和最终测试由精确 PR HEAD 的 GitHub Actions 执行；本地不运行 build/Next dev，避免启动 Docker。受控只读 Provider 验收与 Actions 合成验收分别记录。

## 原生迁移与验收

- 迁移 Epic #60；源码基线、功能清单见 `references/README.md` 与 `docs/migration/FEATURE_INVENTORY.md`。`references/legacy` 不进入默认应用构建、TypeScript 扫描或运行时。完整性检查读取它的哈希清单仅用于审计，不代表业务依赖。
- PR65 仅有一项用户单独授权的旧 OpenBB 测试选择器修订，授权记录见 `docs/evidence/legacy-integrity-authorizations/pr65-openbb-qqq-cell.json`，原件完整保留于 `references/legacy/authorized-originals/pr65/`。冻结 manifest/Tag 不变；完整性工具只接受固定授权摘要和精确修订身份，不允许借此修改其它旧文件或原件。
- 原生 Widget 为静态、已审查的 builtin 注册，不允许任意第三方可执行代码。注册需声明读操作、动作、权限和资源预算；Widget 不可另建 Provider 连接。共享只读市场快照不是完整插件沙箱。
- Yahoo 日线仅经独立原生 research-mode 实例及研究 signer读取；终端实例不得配置研究 signer，研究实例不得配置终端/Engine/Provider 密钥。导航不同端口不能替代不同 hostname 的 cookie 隔离。所有服务密钥仍仅服务端。
- 原生 `EQOBOARD_DATA_DIR` 独立于旧 SQLite。未配置时相关持久接口准确 unavailable；禁止自动迁入/认领旧数据。Workspace CAS、备份、显式旧布局预览/导入必须保持身份边界。
- 原生验收仅由 `Native Web CI` 执行。缺失已提交的 package-lock 或其根依赖与 package 声明不匹配时，bootstrap artifact仅是待审查提案，gate必须失败。未通过新旧对照、成对性能和回滚证据不得切换默认部署。公共 Runner 无真实市场密钥或 Provider 验收；本地不启动 build、Next dev、Docker 或浏览器测试。
- `.agents/skills/native-terminal/SKILL.md` 适用于新终端；旧 OpenTerminal/OpenBB Skill仅用于历史参考或明确的可选旧模块维护，不能覆盖本迁移目标与旧源码保护。
- 用户明确要求本机启动时，可按 `docs/NATIVE_LOCAL_START.md` 运行 Actions 构建并校验的 Windows standalone/Gateway 产物；只做运行与健康检查，不在本机 build、Next dev、Docker 或跑验收测试。凭据仅存 ignored `.env`，按服务白名单分流；本机免登录必须严格 loopback，生产默认仍 OIDC。
