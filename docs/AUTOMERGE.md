# EqoBoard PR 合并与自动合并治理

本文记录专用 GitHub App 自动合并的停用状态和用户授权的 owner operator 自合并门槛。策略代码位于 `tools/auto_merge/`，离线 API 反例测试位于 `tests/auto_merge_policy.test.cjs`。

> **当前不启用 App 自动合并。** `pr-auto-merge.yml` 已从 `.github/workflows` 移除，历史 Actions workflow 已手动禁用。保留的策略代码和测试只用于本地离线治理审查，不会创建 App token 或合并 PR。重新启用需要单独授权和重新审查；不得仅通过配置变量或 Secret 启动。

## 当前状态

截至 2026-10-08，策略模块及 mock GitHub API 离线测试保留为本地治理记录，专用 App workflow 已从仓库工作树移除。`allow_auto_merge=true` 只表示 GitHub 仓库允许使用其 auto-merge 能力，不表示专用 App 已配置或可运行。当前没有自动合并 workflow、App token 或已验收的 App 安装。

已核对的仓库与组织状态：

- 仓库 `allow_auto_merge` 为 `true`；这是 GitHub 仓库设置，不会自行创建 App token 或启动未满足 workflow gate 的 job。
- 本次未读取、创建或写入任何 GitHub App 私钥或自动合并凭据；工作流移除后，App policy job 不会运行。没有专用 App 已安装、具备 bypass 或完成运行验收的证据。
- GitHub environments `market-data-readonly`（ID `23677247498`）和 `auto-merge`（ID `23677256884`）已设为仅允许 `main` 分支部署；于 2026-10-07T11:55Z 通过环境 API 核验。该设置没有写入或读取任何 Secret。
- 组织活动 ruleset `24149994` 要求一个有效审批，并配置 Team `19774274` 为 always bypass actor。本次只使用仓库现有 Owner/Admin/Team 权限处理已授权任务的形式审批门槛，没有更改组织通用 ruleset、降低审批或 required checks，也没有生成虚假的 GitHub review。
- 实读 `GET /repos/lqepoch/EqoBoard/rules/branches/main` 时，`pull_request.parameters.required_approving_review_count` 为 `1`，并同时返回 REST/OpenAPI schema 当前未列出的 `require_extra_approval_for_unattributed_changes: false`。GitHub 官方 ruleset 文档说明清除“unattributed Copilot PR”额外审批设置后只要求配置的审批数；策略因此只接受该字段为布尔 `false`，布尔 `true` 暂时阻断（尚未实现该额外身份条件），类型错误与其它未知参数也阻断。
- 历史 CI run `37588824743` 已关联合并 PR；当前 REST 响应的 `pull_requests` 为空。该数据不能用于候选合并，策略会因无法确认唯一 PR 绑定而拒绝。
- 最近已观察到的 required CI job context 是 `Rust data / gateway / execution`、`Offline market-data contract tests` 和 `OpenTerminal / AG Grid / Next.js`。CI 增加了 auto-merge 策略离线测试但不增加 job 或改名，因此 manifest 仍是这三个 context。实际验收 CI 增加或改名 job 时，必须先更新受信清单和对应 fixture。

PR #29 已在明确的 owner 自合并授权下完成，合并时间为 `2026-10-07T23:27:31Z`（上海时间 `2026-10-08 07:27:31`）。候选 head 为 `e3d596ab6f9dda57c1688bd98f8f7c2eca5b2f09`，该 head 的树为 `b5d04be01f032e029cf5a65e3701420577892bd4`；CI run `37698557986` 和 CodeQL run `37698553366` 对应检查全部 8/8 成功，独立非作者最终 diff 复核没有 P1/P2 阻断，review thread 为 0。通过现有 Owner/Admin/Team 权限后，PR 已合并；merge commit 为 `e1b73c1347ce79d9b86d4e4fe3d1c5942b20ab97`，树与已测 head 一致。相关真实 native 检查为 7/7，default profile 与 cleanup 检查通过。此证据记录的是 PR #29 的一次 owner 自合并，不代表 App 自动合并已启用，也不部署服务或启用 Paper/Live execution。

用户已明确授权本仓库 owner 自合并 PR。该持续授权适用于用户授权的本仓库开发任务及其 PR 范围，不逐任务或逐 PR 重复询问相同合并权限；不覆盖未授权任务或其它仓库。策略测试通过不代表专用 App、App bypass 或自动合并已启用；owner operator 路径必须满足下述独立门槛，不能伪造 review 或降低分支保护。

## 本仓库 owner 持续授权的 operator 自合并

本仓库 owner 自合并已获用户明确授权，持续适用于用户授权的本仓库开发任务及其 PR 范围，不逐任务或逐 PR 重复询问相同合并权限；未授权任务和其它仓库不在此授权范围内。owner 可以在正式审批是唯一剩余 ruleset 门槛时，使用仓库已有 Owner/Admin/Team 权限例外完成合并。此操作不是独立审查，不能创建、冒称或要求 GitHub `APPROVED` 记录；任何有效 `CHANGES_REQUESTED`、未解决 thread 或其它未处理的阻断 review 都必须先由 reviewer 处理，owner 授权或权限例外不能忽略它们。最终 diff 必须由非 PR 作者独立复核并无阻断问题。

每次写入前重新读取 PR 和 `origin/main`，确保 base 指向最新 `main`，固定候选 head SHA，并确认没有冲突。要求当前 head 上受信 manifest required checks 与生效 ruleset required checks 的并集全部成功，且 CodeQL 当前 head 检查成功；pending、失败、陈旧、未知、无法匹配 head 的任何检查都会阻止合并。有效 `CHANGES_REQUESTED` review 与未解决 review thread 必须先由 reviewer 处理。若更新 head 或 base，则重新完成最终 diff 复核并等待自然触发的检查结果；不以空提交或手工 rerun 伪造新证据。

调用 merge 接口时将固定 head SHA 作为 expected SHA；收到结果后复读 PR，核验其已合并以及 merge SHA，再 fetch 远程 `main` 核对合并提交与目标树。若 head、base、规则、review、thread 或检查在最终读取中有变化，停止并重新审查。核验后只清理本任务 worktree/branch：先检查 worktree 是否 dirty 以及私有 `.env`/`.state` 是否需保留，再删除已验证干净的本任务 worktree 与分支；保留必要审计记录，不碰其它任务的 worktree、分支或状态。此流程只用当前仓库已有权限，不改组织通用 ruleset、不降低 required checks、不扩大到其它仓库，也不触发部署或券商操作。

## 专用 App：受信触发与 PR/CI 绑定（未启用的设计记录）

以下 App 规则只记录既有策略审查要求，不对应当前可执行 workflow。

特权工作流只允许在受信 `main` 引用上运行。`workflow_run` 处理器必须运行仓库 `main` 上的工作流定义，不得 checkout、执行或加载 PR head 的代码、脚本或 artifact。它只通过 GitHub API 读取 PR 元数据、文件、review、checks、status、ruleset 和权限。

自动触发只接受当前受信 CI workflow 的最新成功 `pull_request` run。PR 必须开放、非 draft、目标为同仓库 `main`、head 来自同仓库、作者为可信 allowlist 用户，并且 GitHub 返回的 run 必须恰好关联一个 PR。PR head、base SHA、分支、仓库、workflow id/path 和 run 的 `check_suite_id` 都要与当前证据一致。找不到 PR 关联、历史合并 run 已丢失关联、fork、字段缺失或未知状态都 fail closed。

审核完成后可由 `workflow_dispatch` 在 `main` 上传入 PR 编号重新评估；它复用绑定当前 head/base 的最新成功 CI run，不启动新的 CI。分支字段仅由特权 workflow 的 `github.ref == refs/heads/main` job guard 控制；不得给 `workflow_run` 添加 `branches: [main]`，该字段会按上游 PR head 分支过滤并漏掉分支名不是 main 的 PR。写入前重新读取全部关键证据，若 PR head/base、CI run、审批、线程、文件、检查或规则有变化则拒绝。最终 merge API 必须传 `sha: current_head_sha`；冲突不自动重试。收到合并成功后再读取 PR 核验 merged 状态和 merge SHA。

GitHub 官方接口参考：[workflow_run 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)、[特权 workflow 防不可信代码说明](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)、[Actions workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs)、[Pull request reviews API](https://docs.github.com/en/rest/pulls/reviews)、[Check runs API](https://docs.github.com/en/rest/checks/runs)、[commit statuses API](https://docs.github.com/en/rest/commits/statuses)、[branch rules API](https://docs.github.com/en/rest/repos/rules)、[merge pull request API](https://docs.github.com/en/rest/pulls/pulls)。

## 专用 App：审查、路径与检查策略（离线策略代码）

专用 App 策略从 GitHub 活跃分支规则 API 读取 `pull_request.parameters.required_approving_review_count`，并要求配置数量的独立人类审查者；其最新已提交 review 必须是绑定当前 head SHA 的 `APPROVED`。策略的受信最低审批数固定为 1，配置数为 0 时仍要求一名审查者；配置数大于 1 时按更高数量执行。活跃规则响应必须包含至少一个有效 `pull_request` rule；空规则列表或仅有其他规则会以 `pull-request-review-policy-missing` 阻止 App 合并，避免 App bypass 在规则误删或不匹配时降低审批要求。未知 pull-request 参数、缺少或无效的审批数也拒绝。敏感文件还至少需要一名这样的审查者；PR 作者、GitHub App、Bot、无写权限用户和旧 head 上的审批不计入。`CHANGES_REQUESTED` 和未解决 review thread 阻止 App 合并。为避免沿用含义不清的旧批准，较新的 `COMMENTED` 或 `DISMISSED` review 也会使对应审查者的旧批准失效。

GitHub 文档说明，未归属 Copilot PR 的额外审批默认启用；清除该设置后，PR 只需要配置的审批数。官方 REST/OpenAPI 和 Octokit generated schema 目前没有列出 API 返回的 `require_extra_approval_for_unattributed_changes` 扩展字段。专用 App 策略只支持经官方文档确认的布尔 `false`；`true`、`require_code_owner_review` / `require_last_push_approval` 为 `true`、非空 `required_reviewers`、类型错误及其它未知参数都 fail closed。当前这项 API 字段不再阻塞，额外审批或特定审查规则尚未实现时仍阻止 App 自动合并；GitHub App/Secrets 配置也仍未完成。owner operator 流程使用前一节的单独门槛，不改此 App 策略。参考：[ruleset 审批规则](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#additional-approval-for-unattributed-copilot-pull-requests)、[GitHub changelog](https://github.blog/changelog/2026-08-21-shared-agentic-work-with-github-copilot-in-microsoft-teams/)、[REST/OpenAPI schema at `734bc9c`](https://github.com/github/rest-api-description/blob/734bc9c1030b774eb3fc909cce477aceea21cf77/descriptions/api.github.com/api.github.com.2026-03-10.json)、[Octokit generated schema at `83df989`](https://github.com/octokit/openapi-types.ts/blob/83df9890720ab7d64bbaf8e07e57751f1b23ed59/packages/openapi-types/types.d.ts)。

敏感范围覆盖 BFF/API、身份和安全、domain、Alpaca、execution、gateway、根和子项目配置、Docker/Compose、所有 workflow、AGENTS/skills、自动合并策略及其文档。重命名同时检查 `filename` 和 `previous_filename`；文件列表缺失、截断、路径不合法或 rename 来源缺失均拒绝。

App 检查清单是仓库受信 required job manifest 与 `main` 生效 ruleset required status check 的并集。三个 CI job 必须完成成功，且它们的 check run `check_suite_id` 必须匹配候选的最新受信 CI workflow run；相同名称、不同 check suite 的新成功结果不能冒充目标 job。CodeQL 和四个已登记的 Analyze context 是 App 路径的非 required guard：可以缺席，但出现后必须在当前 head 上成功且 provider 匹配。owner operator 路径另要求 CodeQL 当前 head 成功。当前 head 的未知 check/status context、缺失必需 context、pending/failure/error、未知结论或未知 provider 都拒绝。离线策略仍不会按自动合并 workflow 的显示名称跳过检查；只有绑定候选 PR head 的检查才参与判断。

Commit statuses 从 GitHub `List commit statuses for a reference` 接口完整分页，并按不区分大小写的 context 使用最新 `updated_at`、再以 `id` 打破并列；旧 status 不覆盖较新 status。combined-status 只核验 SHA 和 context `total_count`，不把其默认第一页当完整状态集。分页错误、数量不一致、无效时间/ID或超过安全页数都会拒绝。GitHub merge API 仍须服从现有分支保护。

策略测试包含旧策略三类反例：旧 commit 上的外部 approval、无审批的 BFF 变更、从 workflow 敏感路径改名到普通文档；还覆盖真实历史 check-run API fixture、权限/审查矩阵、旧状态、分页遗漏、check-suite 冒充、并发 head 更新和 merge SHA 冲突。运行：

```bash
node --test tests/auto_merge_policy.test.cjs
```

## 专用 GitHub App 启用要求（当前禁止启用）

当前不配置专用 GitHub App、Actions Variable、Actions Secret 或 ruleset bypass actor。下列权限项仅作为停用前设计记录；不得据此添加特权 workflow、创建 token 或给 App 授予合并权限。只有获得单独授权、重审新的特权代码和凭据边界后，才能重新评估是否启用：

- `Contents: write`、`Pull requests: write`：读取 PR 内容和执行 merge。
- `Actions: read`、`Checks: read`、`Commit statuses: read`：核验工作流、checks 和完整 commit status。
- `Metadata: read`：读取 branch rules 与 collaborator permissions。

若未来另行批准启用，仍不得替换组织规则、关闭审批要求、降低 required checks 或伪造批准；PR CI 也不得访问 App 凭据。手工 owner operator 合并不等于专用 App 已启用或验收通过。

## Actions 与工具链固定版本

CI 运行在 `ubuntu-24.04`，并固定 Rust `1.99.0`、Node `22.23.3`、Python `3.12.15`。OpenTerminal build/runtime 两个 Dockerfile stage 使用相同的官方 multi-arch Node 镜像索引 `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`，避免浮动 `node:22` tag。Python 3.12.15 在 `actions/python-versions` 的 Ubuntu 24.04 x64 manifest 中可用。

所有 workflow Action 均以完整 commit SHA 固定：

- `actions/checkout` v6.1.0：`d23441a48e516b6c34aea4fa41551a30e30af803`
- `actions/setup-node` v7.0.0：`820762786026740c76f36085b0efc47a31fe5020`
- `actions/setup-python` v7.0.0：`5fda3b95a4ea91299a34e894583c3862153e4b97`
- `actions/github-script` v9.0.0：`3a2844b7e9c422d3c10d287c895573f7108da1b3`
- `actions/create-github-app-token` v3.2.0：`bcd2ba49218906704ab6c1aa796996da409d3eb1`
- `Swatinem/rust-cache` v2.9.2：`6323deb102c322ba6fcbdcafc7e3dddab59af2b6`
- `dtolnay/rust-toolchain`：`7e38f4b43b4db5c8dd498af069a4f6196df1d067`，显式 toolchain `1.99.0`

版本依据：官方 [Node.js v22.23.3 release](https://github.com/nodejs/node/releases/tag/v22.23.3)、[Python 3.12.15 release](https://www.python.org/downloads/release/python-31215/)、[Python Actions build manifest](https://github.com/actions/python-versions/blob/main/versions-manifest.json) 和 Docker Hub [`node:22.23.3-bookworm-slim`](https://hub.docker.com/layers/library/node/22.23.3-bookworm-slim/images/sha256-c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392)。

本地集成验证在 2026-10-07 完成：`node --test tests/auto_merge_policy.test.cjs` 46/46；Python 离线契约 7/7；Compose production/offline/E2E 配置、`bash -n tools/container-e2e.sh` 和 `actionlint v1.7.12` 通过。固定 Node 镜像实际报告 Node `v22.23.3`、npm `10.9.9`。执行 `npm ci --no-audit --no-fund` 后，`bash tools/container-e2e.sh` 完整通过：生产容器浏览器 11 passed、1 个仅开发态 UNKNOWN 用例按设计 skipped，开发态真实 Next/OIDC 的订单 race/过期/UNKNOWN 用例 3/3。生产 runtime 同一 OpenTerminal Image ID 为 `sha256:8018b23ed9054315f5c1cac9df4d4424e9090351d74582a6fa723b3c4400bdea`；Gateway Image ID 为 `sha256:9bb4c3f3ae91a778586a2a801d5422f2675dac3224d4309965ad6bc9c399bf28`。容器验收仅用离线 mock 和测试身份，无 Alpaca 密钥或委托。

自动合并只改变 GitHub PR 状态；它不启用交易、不触发真实券商委托，也不部署服务。Live 委托仍必须由独立交易安全边界拒绝。
