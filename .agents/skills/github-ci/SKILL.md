---
name: github-ci
description: 治理 GitHub Actions、依赖构建、公共仓库组织 Secrets 隔离、回归与发布安全门槛。
---
# CI & Operations Skill
路径：.github/workflows/**、Dockerfile、compose.yaml。
PR 只允许无密钥 fmt/clippy/test/typecheck/build；market-data-smoke 仅在受信分支、定时、手工读取组织 Secrets ALPACA_KEY / ALPACA_SECRET，执行 GET，不能下单。
每个 PR 必须保留日志及失败证据；引用不受信第三方 Actions 应尽可能锁 SHA，发布生产前冻结 Cargo.lock/package-lock.json 并进行漏洞扫描。
端到端自检：Rust 与 Web build，缺密钥 503，使用授权密钥验证 SIP/OPRA，Paper 流程对账，回滚已知镜像标签。
