# EqoBoard PR 自动合并治理

截至 2026-10-07，仓库已有每小时检查并自动合并绿色 PR 的 ChatGPT 自动化。限定同仓库、可信用户提交、目标 main、最新 CI 全绿、不涉及已知重大安全风险。

## GitHub 原生事件驱动（需要一次性 App 配置）

工作流 .github/workflows/pr-auto-merge.yml 监听 EqoBoard CI 完成的 pull_request。流程不 checkout PR 代码，只读取 GitHub API 元数据，核验来源、作者、目标分支、head SHA、review 状态及文件风险。

组织级规则集 org-default-branch-pr-review-lq-epoch-bypass 仍强制 1 个有效审批，当前仅组织 Team 具有绕过权限。GitHub Actions 默认 GITHUB_TOKEN 没有该 Team 身份。仓库级 allow_auto_merge 当前为 false。

要启用即时无人值守 squash 合并，由组织管理员配置专用 GitHub App：

1. 安装并只允许访问 lqepoch/EqoBoard，权限 Contents write、Pull requests write。
2. 在组织规则集的 bypass actors 中明确加入该 App。保留现有 ruleset；不得批量关闭审查要求。
3. 在 Actions Variables 配置 EQO_AUTOMERGE_APP_ID（App Client ID），在 Actions Secrets 配置 EQO_AUTOMERGE_APP_PRIVATE_KEY（GitHub App 私钥）。
4. 运行受信测试 PR：普通非敏感文件且 CI 全绿可合并；失败、fork、head 已更新、CHANGES_REQUESTED 均不得合并。敏感交易、网关、CI 文件必须额外有 APPROVED 的真实审查。

未配置 App 时，原生 workflow 跳过，系统以每小时检查的 ChatGPT 自动化作为已生效的自动合并途径。即使使用 App，合并也不会启动真实交易或部署。

限制：自动化无法覆盖交易服务实盘检查；CI 检查、审计与风控独立执行。严禁提交 GitHub App 私钥、Alpaca Key、券商凭据和 PAT。
