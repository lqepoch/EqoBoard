---
name: github-ci
description: 治理 GitHub Actions、依赖构建、公共仓库组织 Secrets 隔离、回归与发布安全门槛。
---
# CI & Operations Skill
路径：.github/workflows/**、Dockerfile、compose.yaml。
公共 GitHub Actions 只运行无私密凭据的 fmt/clippy/test/typecheck/build、CodeQL 和源码供应链检查。不得将组织行情、OAuth、Drive 或 GitHub App 凭据传入任何 Action，也不得在 Action 中执行真实行情探测、配额查询、行情导出、artifact 清理或自动合并。对应 workflows 已从 `.github/workflows` 移除；只读 Alpaca 工具保留为操作者本地显式入口，严禁提交输出或上传公开 Actions artifact。普通 PR CI 与 main CI 都不得读取组织私密凭据。
OpenBB Lite 的源码供应链与运行时验收位于独立的 `.github/workflows/openbb.yml`（workflow 名 `OpenBB Optional CI`）。稳定 required job `OpenBB optional validation gate` 每次 PR/push 都运行路径路由和结果汇总；无相关改动时它成功退出，而 `OpenBB source supply chain` 与 `OpenBB native runtime E2E` 两个重型 lane 可跳过。OpenBB source、recipe、测试及共享 research/BFF、身份、Gateway、契约、依赖、容器或 CI 基础设施改动必须按路由触发对应重型 lane；手动 `workflow_dispatch` 与每周 schedule 运行完整 source 和 runtime lane。路径无法可靠确定时 fail closed 并运行完整验收。路由器使用 Git rename/copy detection，并对重命名或复制同时分类旧路径和新路径；Git stderr 警告、diff 超时或缺失、不完整的路径证据都必须 fail closed。源码 archive/license 校验、source-only SPDX SBOM、patched-source SPDX SBOM、upstream drift report 由 source lane 生成；runtime lane 在 GitHub Actions 构建 OpenBB Lite 并运行原生浏览器/容器 E2E。两类 SBOM 与 drift artifact 都不互相替代，source SBOM 也不是运行镜像 SBOM。OpenBB Lite 的 CI/release 验收构建和证据必须来自该 Actions workflow；本地开发尝试不构成验收，workflow 不接触市场数据凭据。
每个 PR 必须保留日志及失败证据。所有第三方 Actions 必须固定完整 commit SHA 并在升级时核对 action runtime、权限输入和官方 release；Cargo.lock/package-lock.json 锁定依赖。当前 CI 固定 `ubuntu-24.04`、Rust 1.99.0、Node 22.23.3、Python 3.12.15；OpenTerminal Docker Node base 固定 tag 与完整多架构 digest。升级工具链时运行对应大模块测试并同步 `.github/workflows/ci.yml`、Dockerfile 和此处记录。

`OpenTerminal / AG Grid / Next.js` 仍是核心 required job，负责核心应用构建、核心容器回归和核心路由测试，不再承载 OpenBB Lite 镜像构建或原生 Lite 浏览器 E2E。可选 OpenBB workflow 使用独立稳定 required check `OpenBB optional validation gate`；路由、source、runtime 和 gate 四个 check run 都必须在候选 head 的同一 workflow suite 中出现。路由 guard 与 gate 必须成功；source/runtime guard 只在路由明确声明无需执行时允许 skipped，缺失、pending、failure、cancelled 或 neutral 均阻断。运行时、研究认证/BFF/导航、Gateway/market-contract、Cargo/npm 锁、Docker/Compose、CI 和测试工具等共享路径必须触发相关 OpenBB lane。手动与每周运行始终执行完整 source 和 runtime 验收。修改路由时更新独立 workflow 的路由契约测试，覆盖核心/无关路径、OpenBB 专属路径、共享路径以及不完整 diff 的 fail-closed 行为。

核心生产容器 E2E 使用官方固定 SHA 的 `docker/setup-buildx-action` 与 `docker/build-push-action`（当前分别为 v4.4.1 与 v7.4.0）预构建 Gateway、OpenTerminal runtime 和 Compose E2E 镜像。OpenBB Lite 镜像只由独立 OpenBB runtime lane 构建和测试。每个镜像/target 使用不同 GitHub Actions cache scope 与 GHA cache backend v2；导出设置 `ignore-error=true`，导出失败只减少后续缓存复用。PR workflow 可读取 base/default branch cache，但 GitHub 将其写入限制在当前 PR merge ref；main push 与目标为 main 的 `workflow_dispatch` 更新默认分支 cache ref，其它 ref 的 dispatch 使用相应分支 cache ref，不得用额外 cache 写权限绕过此边界。预构建使用 action 选定的 Buildx builder，并把结果加载到 Docker daemon；随后 E2E wrapper 只接收 `BUILDX_BUILDER` 和 `COMPOSE_BAKE` 两个非密钥值，让 `docker compose up --build` 复用同一 builder。不得把 `ACTIONS_RUNTIME_TOKEN`、cache URL 或结果 URL传进 shell、Compose 配置、测试进程或 artifact。缓存不承载测试结论，cache miss 不能改变验收范围。
Docker build context 通过 `.dockerignore` 排除生成的 `**/test-results` 与 `**/playwright-report`，避免 Playwright trace/report 改动失效镜像缓存；源 E2E 测试与 fixture 保留在构建上下文中。
离线端到端自检使用 mock 验证身份边界、真实容器健康/readiness、市场数据状态和执行默认关闭；Paper submit 必须被阻止且 broker adapter 调用数为零。它不证明券商 Paper 对账或账户生命周期。真实 SIP/OPRA 只读检查只能由获准操作者在隔离本机环境显式运行，并单独记录其网络、凭据来源和 entitlement 证据；公共 Action 不执行。Paper 账户对账、持久幂等及生命周期验收属于 #2-B/C 后续门槛，在完成前不得启用执行。

## PR 合并与自动合并策略

专用 GitHub App 自动合并 workflow 当前已移除，策略代码与反例测试仅保留为本地离线审查记录。不得仅通过变量、Secret、App 安装或 ruleset 配置重新启用；需单独授权并重新审查完整特权路径。获准的本仓库 owner operator 自合并按 `docs/AUTOMERGE.md` 的任务自审自合并门槛执行。

### 专用 GitHub App 自动合并

自动合并判断代码只能由受信 `main` 工作流加载。`workflow_run` 与特权 `workflow_dispatch` 不得 checkout、执行或导入 PR head、PR artifact 或 PR 提供的脚本；PR 内容只通过只读 GitHub API 读取。

策略模块位于 `tools/auto_merge/`，契约测试运行 `node --test tests/auto_merge_policy.test.cjs`。修改策略时至少保留：审查者 GitHub 用户类型/权限/独立性、latest submitted review 对当前 head SHA 的绑定、当前分支规则要求的审批数且最低为一（缺少有效 `pull_request` rule、未知 pull-request 参数或无效审批数 fail closed）、敏感路径 current/previous filename、有效 ruleset required-check 并集、未知和缺失状态 fail closed、候选 CI workflow/check-suite 身份、分页边界、写入前复读及 merge SHA 前置条件。该 App 始终要求非作者的有效 GitHub 人类 `APPROVED` review；owner 自合并授权不改变 App 策略，也不算作这项 review。新增或改名 CI job 必须同步更新受信检查清单和 API fixture。

GitHub `combined status` 默认每页 30 条，不可作为完整状态集合。读取 commit statuses 时使用带上限的 REST 分页，并按 context 取最新 `updated_at`/`id`；combined response 只校验 head SHA 和 context 数量。任何 API 分页失败、未知状态/provider 或候选关联缺失都必须阻止写操作。

自动合并 App 仅可由组织管理员在策略、可信 workflow 和无密钥 PR 检查通过后配置。App 权限按被调用接口所需最小化；当前实现读 Actions、Checks、Commit statuses、Metadata，合并需 Pull requests/Contents 写权限。组织 Secrets 只进入受信 `main` 特权工作流，普通 PR CI 永不读取。App 安装、Ruleset bypass 或实测合并缺证据时，只能报告 App 路径未验收，不降低分支保护。

### 本仓库 owner 持续授权下的任务自合并

用户已明确授权本仓库 owner 自合并 PR。该持续授权适用于用户授权的本仓库开发任务及其 PR 范围，无须逐任务或逐 PR 重复询问相同合并权限；它不适用于未授权任务或其它仓库。此 operator 路径与专用 App 分开运行，不改变自动合并策略、分支 ruleset 或组织通用权限。若现有仓库 Owner/Admin/Team 权限例外能处理唯一剩余的形式审批门槛，可按授权使用；这不构成独立 review，不能写入或声称存在 GitHub `APPROVED`。

合并前必须刷新 `origin/main` 与 PR，确认目标为同仓库 `main`、PR base 是最新远程 `main`、head SHA 已冻结且无冲突；仓库受信 required-check manifest 与当前 ruleset required checks 的并集，以及 CodeQL，都必须在这个 head SHA 上成功。任何必需或已出现的检查为 pending、失败、过期、未知或无法归属到该 head 时都停止。`CHANGES_REQUESTED`、未解决 review thread 或其它未处理的阻断 review 也会阻止合并，不能用 owner 授权或权限例外忽略。作者可对最终 diff 自审，无须等待非作者；在 PR 评论记录绑定最终 head SHA 的 scope、findings、validation 和 `SELF_REVIEW`，不得冒称独立复核。必要时更新 PR 后重新等待自然触发的检查与复核，不用空提交或手工重跑来制造通过记录。通过 GitHub 写入接口时以冻结的 head SHA 作为期望值；合并后读取 PR 并核验 merged 状态、merge SHA 和远程 `main`。核验后先检查本任务 worktree 的 dirty 状态和私有 `.env`/`.state`，再清理本任务干净的 worktree 与分支；保留需留存的私有状态，绝不删除其它任务的 worktree 或分支。仅能使用仓库现有权限，不能为当前任务改动组织级 ruleset 或其它仓库的权限。合并不部署服务，Paper 和 Live execution 仍保持 disabled。

## Native Web migration lane

`Native Web CI` (`.github/workflows/native-web.yml`) 独立验证 `apps/eqoboard-web`，app-only Docker context，不拉取旧应用运行时。`Native web validation gate` 汇总 lock bootstrap 与 package/runtime 检查，任何失败、缺失或跳过都阻止合并。缺少已提交 lock 或其根依赖与 package 声明不匹配时，只上传待审核 bootstrap lock并失败；已有 lock 作为依赖裁剪输入，避免无关版本重解，不将临时生成依赖计入验收。终端/Research使用同一个原生镜像、独立hostname与密钥，CI仅标准OIDC合成fixture。旧 core/OpenBB required checks与CodeQL继续保留；未完成迁移不得移除旧可用部署或降低已有门槛。

原生 lane 使用 Gitleaks 8.30.1 的固定 linux/amd64 镜像 digest 扫描原生工作树及候选提交范围，关闭网络、只读挂载并脱敏日志。只在 GitHub Actions 启动该容器；不向扫描器传递任何组织凭据，不因测试 fixture 而全局排除密钥规则。依赖许可证检查同时核对 SPDX 语法、精确锁定的运行时排除清单、standalone/final image 文件边界与镜像 SBOM；源码依赖的许可证审计不等于 Provider 数据许可或生产发布验收。

原生镜像构建写入候选 revision label。SBOM helper 接收 build action 的 config ID 与 build digest，核对实际镜像 ID/label，按不可变 config ID 扫描；身份收据绑定候选 SHA/Tree、app lock 与两份 SBOM 的 SHA-256。源码库存与运行镜像库存分类保留，既有收据不得覆盖。浏览器失败后仍独立采集已成功构建镜像的 SBOM，但整个验收 gate 继续失败；身份绑定不代表运行时许可闭合或 RELEASE_ACCEPTED。
