# Security Policy / 安全报告

请勿通过公开 Issue、PR 或构建日志发布 API 密钥、账户号码、订单回报及个人数据。漏洞报告请优先使用 GitHub Repository → Security → Report a vulnerability（若已开启），否则联系仓库所有者的私有渠道。

该公共仓库默认屏蔽 live 委托。部署到公网需先配置 TLS、访问令牌及强制认证；机构/多用户场景须引入正式 RBAC/OIDC、交易审批和交易所数据再分发许可。详情见 docs/SECURITY.md。
