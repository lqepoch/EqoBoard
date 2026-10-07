# 安全边界

- **组织 Actions Secrets**：ALPACA_KEY / ALPACA_SECRET。CI pull_request 工作流从不读取；独立 smoke 定时或手工在受信主分支运行，只发 GET，无任何订单接口访问。
- **本机密钥**：后端进程环境变量或受管 Secret Store。前端 bundle 不含 Alpaca 凭据；README、样例、测试用无真实 Key。
- **绑定/授权**：默认 127.0.0.1。面向公网绑定需要 EQO_ACCESS_TOKEN；浏览器在设置中录入，会话内存储于 sessionStorage，关闭会话失效。正式部署前使用 OIDC/session HttpOnly/SameSite、TLS 和反向代理访问控制。
- **下单门闩**：默认为 disabled。paper 环境仍有模拟风险，受额度、一次性 preview ID、明确确认、服务端审计和券商端二次风控约束。
- **审计/故障**：append-only JSONL 初始记录，生产迁移持久数据库/WORM 审计。网络超时后禁止无查询重发；服务必须支持 idempotency / reconciliation。
- **第三方分发**：SIP/OPRA 的许可不自动覆盖公共市场数据展示服务；公开 GitHub 仓库只有代码，禁止公开持钥演示端点。
