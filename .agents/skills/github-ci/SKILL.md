---
name: github-ci
description: 治理 GitHub Actions、依赖构建、公共仓库组织 Secrets 隔离、回归与发布安全门槛。
---
# CI & Operations Skill
路径：.github/workflows/**、Dockerfile、compose.yaml。
PR 只允许无密钥 fmt/clippy/test/typecheck/build；market-data-smoke 仅在同仓库 `main` 受保护 `market-data-readonly` environment 中读取 ALPACA_KEY / ALPACA_SECRET，执行 GET，不能下单。定时、main 数据路径变更和手工触发都必须通过 `github.ref == refs/heads/main` job guard；pull_request CI 永不读取组织市场数据 Secrets。
现有 `market-contracts` job 还会从固定 codeload URL 获取 OpenBB Workspace source archive，校验 archive、Apache LICENSE/NOTICE 与 Syft release archive 的锁定 SHA，连续扫描三次并上传 upstream source-only 与 community-patched source-only SPDX SBOM。扫描纳入 JavaScript dev dependencies 并在规范化 package name/version 集合或条目数变化时失败关闭，以规避已确认的 Syft 1.54.1 Bun lock 重复包名不稳定问题。该 job 还运行 `tools/openbb/upstream-diff.sh`，验证锁定的社区 patch/support hashes，生成逐文件 exact/modified/added/deleted JSON 并上传独立 drift artifact。SBOM和drift artifact都不是运行镜像SBOM或浏览器集成证据；该 job 不构建 OpenBB Lite 镜像，也不接触市场数据凭据。
每个 PR 必须保留日志及失败证据。所有第三方 Actions 必须固定完整 commit SHA 并在升级时核对 action runtime、权限输入和官方 release；Cargo.lock/package-lock.json 锁定依赖。当前 CI 固定 `ubuntu-24.04`、Rust 1.99.0、Node 22.23.3、Python 3.12.15；OpenTerminal Docker Node base 固定 tag 与完整多架构 digest。升级工具链时运行对应大模块测试并同步 `.github/workflows/ci.yml`、Dockerfile 和此处记录。
离线端到端自检使用 mock 验证身份边界、真实容器健康/readiness、市场数据状态和执行默认关闭；Paper submit 必须被阻止且 broker adapter 调用数为零。它不证明券商 Paper 对账或账户生命周期。真实 SIP/OPRA 只读 smoke 仅在受保护主分支使用组织凭据；Paper 账户对账、持久幂等及生命周期验收属于 #2-B/C 后续门槛，在完成前不得启用执行。

## PR 合并与自动合并策略

### 专用 GitHub App 自动合并

自动合并判断代码只能由受信 `main` 工作流加载。`workflow_run` 与特权 `workflow_dispatch` 不得 checkout、执行或导入 PR head、PR artifact 或 PR 提供的脚本；PR 内容只通过只读 GitHub API 读取。

策略模块位于 `tools/auto_merge/`，契约测试运行 `node --test tests/auto_merge_policy.test.cjs`。修改策略时至少保留：审查者 GitHub 用户类型/权限/独立性、latest submitted review 对当前 head SHA 的绑定、当前分支规则要求的审批数且最低为一（缺少有效 `pull_request` rule、未知 pull-request 参数或无效审批数 fail closed）、敏感路径 current/previous filename、有效 ruleset required-check 并集、未知和缺失状态 fail closed、候选 CI workflow/check-suite 身份、分页边界、写入前复读及 merge SHA 前置条件。该 App 始终要求非作者的有效 GitHub 人类 `APPROVED` review；owner 自合并授权不改变 App 策略，也不算作这项 review。新增或改名 CI job 必须同步更新受信检查清单和 API fixture。

GitHub `combined status` 默认每页 30 条，不可作为完整状态集合。读取 commit statuses 时使用带上限的 REST 分页，并按 context 取最新 `updated_at`/`id`；combined response 只校验 head SHA 和 context 数量。任何 API 分页失败、未知状态/provider 或候选关联缺失都必须阻止写操作。

自动合并 App 仅可由组织管理员在策略、可信 workflow 和无密钥 PR 检查通过后配置。App 权限按被调用接口所需最小化；当前实现读 Actions、Checks、Commit statuses、Metadata，合并需 Pull requests/Contents 写权限。组织 Secrets 只进入受信 `main` 特权工作流，普通 PR CI 永不读取。App 安装、Ruleset bypass 或实测合并缺证据时，只能报告 App 路径未验收，不降低分支保护。

### Owner 明确授权后的任务自合并

当用户明确授权 owner 自合并时，该授权在当前任务及其 PR 范围内持续有效，无须逐 PR 重新询问。此 operator 路径与专用 App 分开运行，不改变自动合并策略、分支 ruleset 或组织通用权限。若现有仓库 Owner/Admin/Team 权限例外能处理唯一剩余的形式审批门槛，可按授权使用；这不构成独立 review，不能写入或声称存在 GitHub `APPROVED`。

合并前必须刷新 `origin/main` 与 PR，确认目标为同仓库 `main`、PR base 是最新远程 `main`、head SHA 已冻结且无冲突；仓库受信 required-check manifest 与当前 ruleset required checks 的并集，以及 CodeQL，都必须在这个 head SHA 上成功。任何必需或已出现的检查为 pending、失败、过期、未知或无法归属到该 head 时都停止。还必须没有未解决 review thread，并由非作者对最终 diff 完成独立代码复核且没有阻断问题。必要时更新 PR 后重新等待自然触发的检查与复核，不用空提交或手工重跑来制造通过记录。通过 GitHub 写入接口时以冻结的 head SHA 作为期望值；合并后读取 PR 并核验 merged 状态、merge SHA 和远程 `main`。仅能使用仓库现有权限，不能为当前任务改动组织级 ruleset 或其它仓库的权限。合并不部署服务，Paper 和 Live execution 仍保持 disabled。
