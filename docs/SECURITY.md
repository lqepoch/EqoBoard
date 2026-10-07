# 安全边界

- **组织 Actions Secrets**：ALPACA_KEY / ALPACA_SECRET。CI pull_request 工作流从不读取；独立 smoke 定时或手工在受信主分支运行，只发 GET，无任何订单接口访问。
- **本机密钥**：后端进程环境变量或受管 Secret Store。前端 bundle 不含 Alpaca 凭据；README、样例、测试用无真实 Key。
- **用户身份**：OpenTerminal 使用固定 OIDC issuer 的 PKCE + state 登录和 NextAuth 加密 HttpOnly/SameSite=Lax cookie；HTTPS 部署启用 Secure cookie。`EQO_SESSION_TTL_SECONDS` 默认 3600 秒、范围 5..86400 秒，是滚动会话的空闲期限；SSE 使用建立连接时签发的短时委托，并在该委托/会话到期时断开，不会靠后台刷新延长旧流。角色只从已验证的 issuer `roles` claim allowlist 映射，浏览器 session update 不可提升权限。写请求校验同源 Origin、Fetch Metadata、JSON 类型、64 KiB 上限和 5 秒 body deadline。
- **服务身份**：Next BFF 将用户身份与 action scope 换成 60 秒签名 token。Gateway `bff` key 只放在 Next 与 Rust；独立的 research key 供 Next/Node/Rust 使用，Node 签发的 Gateway 子 token 只能是 `market:read`。Rust 按 kid、issuer、audience、算法、有效期和 scope 验证，不接受客户端身份头。Node 同时要求私有服务 key 与用户委托 token。
- **部署边界**：`EQO_ACCESS_TOKEN` 已退役，不能代替用户委托。Compose 默认只将 OpenTerminal BFF 和 Rust Gateway 的本机开发端口绑定到 `127.0.0.1`；research Node API 不发布宿主端口。部署到网络入口时只公开 TLS 反向代理后的 BFF，不公开 Gateway/Node。必须配置可信 OIDC、TLS 和彼此独立的 `NEXTAUTH_SECRET`、Gateway 签名 key、research 签名 key。缺少认证配置时登录不可用、BFF 不向下游发请求，Gateway `/readyz` 返回 503；其身份检查通过后 `/readyz` 仍明确报告 `market_data_ready=false`，因为身份就绪不证明 SIP/OPRA entitlement 或数据流健康。
- **工作区隔离**：Portfolio 按 OIDC issuer + subject 的散列 owner 隔离。旧本机 portfolio 会保留在 `local` owner 下，不自动归属到第一个登录用户；升级数据库前备份持久卷。数据库迁移保留 portfolio/transaction ID 和记录，并建立 owner/name 唯一约束。
- **下单门闩**：Gateway 本版本无论 `EQO_EXECUTION_MODE` 请求值为何都将 effective mode 固定为 disabled；只拒绝未知配置值，Paper submit 返回 blocked 且不消费 preview、不调用券商。Live 始终禁用。离线 preview 不代表券商 Paper，只有完成持久 intent/outbox、账户身份和恢复门闩后才可另行启用。
- **审计/故障**：append-only JSONL 初始记录，生产迁移持久数据库/WORM 审计。网络超时后禁止无查询重发；服务必须支持 idempotency / reconciliation。
- **第三方分发**：SIP/OPRA 的许可不自动覆盖公共市场数据展示服务；公开 GitHub 仓库只有代码，禁止公开持钥演示端点。
