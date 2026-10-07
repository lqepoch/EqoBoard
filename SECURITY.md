# Security Policy / 安全报告

请勿通过公开 Issue、PR 或构建日志发布 API 密钥、账户号码、订单回报及个人数据。漏洞报告请优先使用 GitHub Repository → Security → Report a vulnerability（若已开启），否则联系仓库所有者的私有渠道。

该公共仓库默认屏蔽 Paper 与 Live 委托。OpenTerminal 对外部署需使用可信 OIDC、TLS、短时 HttpOnly 会话及独立服务委托密钥；禁止把共享 Gateway token 发给浏览器。详情见 docs/SECURITY.md。
