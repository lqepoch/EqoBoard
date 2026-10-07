---
name: github-ci
description: 治理 GitHub Actions、依赖构建、公共仓库组织 Secrets 隔离、回归与发布安全门槛。
---
# CI & Operations Skill
路径：.github/workflows/**、Dockerfile、compose.yaml。
PR 只允许无密钥 fmt/clippy/test/typecheck/build；market-data-smoke 仅在受信分支、定时、手工读取组织 Secrets ALPACA_KEY / ALPACA_SECRET，执行 GET，不能下单。
每个 PR 必须保留日志及失败证据；引用不受信第三方 Actions 应尽可能锁 SHA，发布生产前冻结 Cargo.lock/package-lock.json 并进行漏洞扫描。
端到端自检：Rust 与 Web build，缺密钥 503，使用授权密钥验证 SIP/OPRA，Paper 流程对账，回滚已知镜像标签。

## PR 自动合并策略

自动合并判断代码只能由受信 `main` 工作流加载。`workflow_run` 与特权 `workflow_dispatch` 不得 checkout、执行或导入 PR head、PR artifact 或 PR 提供的脚本；PR 内容只通过只读 GitHub API 读取。

策略模块位于 `tools/auto_merge/`，契约测试运行 `node --test tests/auto_merge_policy.test.cjs`。修改策略时至少保留：审查者 GitHub 用户类型/权限/独立性、latest submitted review 对当前 head SHA 的绑定、敏感路径 current/previous filename、有效 ruleset required-check 并集、未知和缺失状态 fail closed、候选 CI workflow/check-suite 身份、分页边界、写入前复读及 merge SHA 前置条件。新增或改名 CI job 必须同步更新受信检查清单和 API fixture。

GitHub `combined status` 默认每页 30 条，不可作为完整状态集合。读取 commit statuses 时使用带上限的 REST 分页，并按 context 取最新 `updated_at`/`id`；combined response 只校验 head SHA 和 context 数量。任何 API 分页失败、未知状态/provider 或候选关联缺失都必须阻止写操作。

自动合并 App 仅可由组织管理员在策略、可信 workflow 和无密钥 PR 检查通过后配置。App 权限按被调用接口所需最小化；当前实现读 Actions、Checks、Commit statuses、Metadata，合并需 Pull requests/Contents 写权限。组织 Secrets 只进入受信 `main` 特权工作流，普通 PR CI 永不读取。App 安装、Ruleset bypass 或实测合并缺证据时，文档和 Issue 保持未完成，不降低分支保护。
