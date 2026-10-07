# EqoBoard PR 自动合并治理

本文描述自动合并的策略边界、证据来源和当前启用状态。策略代码位于 `tools/auto_merge/`，离线 API 反例测试位于 `tests/auto_merge_policy.test.cjs`。

## 当前状态

截至 2026-10-07，策略模块及其 mock GitHub API 测试已经实现。它尚未接入 `.github/workflows/pr-auto-merge.yml`；在集成 PR 替换旧内联判断、测试通过并完成权限配置前，不得把本模块描述为已启用的自动合并保护。

已核对的仓库状态：

- 仓库 `allow_auto_merge` 为 `false`。
- `EQO_AUTOMERGE_APP_ID` 等 Actions Variables 未配置；最近一次 `Trusted PR Auto Merge` 工作流运行被跳过。
- `main` 当前组织规则要求一个有效审批，Team 是已配置的 bypass actor。没有证据表明专用 App 已安装或能够通过该规则。
- 实读 `GET /repos/lqepoch/EqoBoard/rules/branches/main` 时，`pull_request.parameters.required_approving_review_count` 为 `1`，并同时返回官方 REST schema 未列出的 `require_extra_approval_for_unattributed_changes: false`。策略对未知 pull-request 参数 fail closed，因此遇到这个实际响应会阻止合并；在确认该字段语义和兼容方式前，不得启用自动合并。
- 历史 CI run `37588824743` 已关联合并 PR；当前 REST 响应的 `pull_requests` 为空。该数据不能用于候选合并，策略会因无法确认唯一 PR 绑定而拒绝。
- 最近已观察到的 required CI job context 是 `Rust data / gateway / execution`、`Offline market-data contract tests` 和 `OpenTerminal / AG Grid / Next.js`。实际验收 CI 增加或改名 job 时，必须先更新受信清单和对应 fixture。

这些事实说明策略测试已通过，不代表自动合并 App、Ruleset bypass 或 GitHub 工作流已经完成运行验收。管理员配置缺失时保持阻止状态，不伪造 review 或降低分支保护。

## 受信触发与 PR/CI 绑定

特权工作流只允许在受信 `main` 引用上运行。`workflow_run` 处理器必须运行仓库 `main` 上的工作流定义，不得 checkout、执行或加载 PR head 的代码、脚本或 artifact。它只通过 GitHub API 读取 PR 元数据、文件、review、checks、status、ruleset 和权限。

自动触发只接受当前受信 CI workflow 的最新成功 `pull_request` run。PR 必须开放、非 draft、目标为同仓库 `main`、head 来自同仓库、作者为可信 allowlist 用户，并且 GitHub 返回的 run 必须恰好关联一个 PR。PR head、base SHA、分支、仓库、workflow id/path 和 run 的 `check_suite_id` 都要与当前证据一致。找不到 PR 关联、历史合并 run 已丢失关联、fork、字段缺失或未知状态都 fail closed。

审核完成后可由 `workflow_dispatch` 在 `main` 上传入 PR 编号重新评估；它复用绑定当前 head/base 的最新成功 CI run，不启动新的 CI。写入前重新读取全部关键证据，若 PR head/base、CI run、审批、线程、文件、检查或规则有变化则拒绝。最终 merge API 必须传 `sha: current_head_sha`；冲突不自动重试。收到合并成功后再读取 PR 核验 merged 状态和 merge SHA。

GitHub 官方接口参考：[workflow_run 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)、[特权 workflow 防不可信代码说明](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)、[Actions workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs)、[Pull request reviews API](https://docs.github.com/en/rest/pulls/reviews)、[Check runs API](https://docs.github.com/en/rest/checks/runs)、[commit statuses API](https://docs.github.com/en/rest/commits/statuses)、[branch rules API](https://docs.github.com/en/rest/repos/rules)、[merge pull request API](https://docs.github.com/en/rest/pulls/pulls)。

## 审查、路径与检查策略

当前分支规则中的 `pull_request.parameters.required_approving_review_count` 应用于所有 PR；策略从 GitHub 活跃分支规则 API 读取并要求对应数量的独立人类审查者，其最新已提交 review 必须是绑定当前 head SHA 的 `APPROVED`。未知 pull-request 参数、缺少或无效的审批数均拒绝。敏感文件还至少需要一名这样的审查者；PR 作者、GitHub App、Bot、无写权限用户和旧 head 上的审批不计入。`CHANGES_REQUESTED` 和未解决 review thread 阻止合并。为避免沿用含义不清的旧批准，较新的 `COMMENTED` 或 `DISMISSED` review 也会使对应审查者的旧批准失效。

敏感范围覆盖 BFF/API、身份和安全、domain、Alpaca、execution、gateway、根和子项目配置、Docker/Compose、所有 workflow、AGENTS/skills、自动合并策略及其文档。重命名同时检查 `filename` 和 `previous_filename`；文件列表缺失、截断、路径不合法或 rename 来源缺失均拒绝。

检查清单是仓库受信 required job manifest 与 `main` 生效 ruleset required status check 的并集。三个 CI job 必须完成成功，且它们的 check run `check_suite_id` 必须匹配候选的最新受信 CI workflow run；相同名称、不同 check suite 的新成功结果不能冒充目标 job。CodeQL 和四个已登记的 Analyze context 是非 required guard：可以缺席，但出现后必须在当前 head 上成功且 provider 匹配。当前 head 的未知 check/status context、缺失必需 context、pending/failure/error、未知结论或未知 provider 都拒绝。正在运行的自动合并工作流自身不按显示名称跳过；只有绑定候选 PR head 的检查才参与判断。

Commit statuses 从 GitHub `List commit statuses for a reference` 接口完整分页，并按不区分大小写的 context 使用最新 `updated_at`、再以 `id` 打破并列；旧 status 不覆盖较新 status。combined-status 只核验 SHA 和 context `total_count`，不把其默认第一页当完整状态集。分页错误、数量不一致、无效时间/ID或超过安全页数都会拒绝。GitHub merge API 仍须服从现有分支保护。

策略测试包含旧策略三类反例：旧 commit 上的外部 approval、无审批的 BFF 变更、从 workflow 敏感路径改名到普通文档；还覆盖真实历史 check-run API fixture、权限/审查矩阵、旧状态、分页遗漏、check-suite 冒充、并发 head 更新和 merge SHA 冲突。运行：

```bash
node --test tests/auto_merge_policy.test.cjs
```

## 专用 GitHub App 启用要求

只有策略和特权 workflow 都由受信 `main` 提供并通过审查后，组织管理员才能配置专用 GitHub App。限制安装范围为 `lqepoch/EqoBoard`。按所调用 GitHub REST API 的官方权限表授予所需最小权限：

- `Contents: write`、`Pull requests: write`：读取 PR 内容和执行 merge。
- `Actions: read`、`Checks: read`、`Commit statuses: read`：核验工作流、checks 和完整 commit status。
- `Metadata: read`：读取 branch rules 与 collaborator permissions。

管理员还必须按现有组织规则添加该专用 App 的 bypass actor；不得替换规则、关闭审批要求、降低 required checks 或伪造批准。私钥放 Actions Secret `EQO_AUTOMERGE_APP_PRIVATE_KEY`，App ID 放 Actions Variable `EQO_AUTOMERGE_APP_ID`。PR CI 不可访问这两项 Secrets。App 安装、Ruleset bypass、当前开放 PR 的 run 关联和端到端 merge 成功均须保留实际证据后，才能宣布自动合并运行验收完成。

自动合并只改变 GitHub PR 状态；它不启用交易、不触发真实券商委托，也不部署服务。Live 委托仍必须由独立交易安全边界拒绝。
