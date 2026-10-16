# Windows 原生终端本机运行

仅用于明确授权的本机评估。使用 `Native Web CI` 的 Windows 运行包，不在
本机构建、运行 Next dev 或 Docker。原生候选的生产许可与完整迁移验收仍未
通过；默认 Compose 仍保留旧终端。此流程不启用 Paper/Live 委托。

## 准备

需要 Windows x64、PowerShell 7、Node.js **22.23.3** 官方预编译版本和 GitHub CLI。
下载官方 Node Windows zip 时核对该版本官方 `SHASUMS256.txt`，保留随包许可证。
不要用本机不同版本的 Node 重新编译 SQLite 或 Next。

根目录 `.env` 必须保持 Git ignored，并以当前用户和 SYSTEM 的独占 ACL 保存。
填写 `ALPACA_KEY` / `ALPACA_SECRET`；`APCA_API_BASE_URL` 使用
`https://paper-api.alpaca.markets`，`ALPACA_PAPER_ENDPOINT` 记录完整 `/v2` 端点。
这两个 Paper 目标仅为本机外部执行适配器的配置记录，当前 Gateway 不直接用它们
提交订单，`EQO_EXECUTION_MODE=disabled` 必须保留。

本机配置还需：

```dotenv
EQO_LOCAL_ACCESS=true
EQO_LOCAL_BIND=127.0.0.1
EQO_BFF_MODE=terminal
EQO_PUBLIC_ORIGIN=http://127.0.0.1:3000
NEXTAUTH_URL=http://127.0.0.1:3000
EQO_RUST_URL=http://127.0.0.1:8080
EQO_BIND=127.0.0.1:8080
EQO_MARKET_DATA_PROVIDER=futu
EQO_STOCK_SYMBOLS=QQQ,SPY
EQO_MAX_STOCK_SUBSCRIPTIONS=32
FUTU_OPEND_HOST=127.0.0.1
FUTU_OPEND_WEBSOCKET_PORT=12345
FUTU_OPEND_WEBSOCKET_SSL=false
FUTU_OPEND_WEBSOCKET_KEY=
EQO_EXECUTION_MODE=disabled
```

`NEXTAUTH_SECRET`、`EQO_GATEWAY_JWT_SECRET`、`EQO_RESEARCH_JWT_SECRET` 分别使用
独立随机值（至少 32 字节；建议各自 64 个十六进制字符），不要复用 Provider
凭据。Futu SSL/key 必须匹配 OpenD 实际设置；端口可连接不等于 SDK 登录成功。
默认缺少 OpenD 或权限时，真实状态保持 disconnected/unavailable，不回退伪造数据。

本机身份只在显式启用、IPv4 loopback 绑定、Host/Origin/端口及配置一致时有效。
用户归属为独立 local-workstation issuer/subject，不冒称 OIDC。Research runtime
拒绝该模式，公共部署仍使用 OIDC。保留写请求的同源与 Fetch Metadata 校验、
服务端 scope 和独立 signer。拒绝远端 Host、冲突的代理转发头及跨源请求。

## 下载与启动

选择目标 commit 上 **全部 Native Web CI 门禁成功** 的 run。Windows lane 会先
构建 Rust Gateway 和 Next standalone，再对实际运行包执行本机身份、工作区保存、
跨源拒绝的浏览器验收；不包含任何真实行情或私有凭据。
Windows TLS 构建使用固定 NASM 2.16.03 官方 zip，并校验提交的 SHA-256；
NASM 仅在 Actions 构建机使用，本机运行包不需要安装它。

```powershell
gh run download <run-id> --repo lqepoch/EqoBoard --name native-windows-<candidate-sha>-<run-id> --dir data/native-local/download
# 校验 ARCHIVE_SHA256SUMS 中 zip 的 SHA-256，再解压到独立空目录。
Expand-Archive data/native-local/download/eqoboard-windows-x64.zip data/native-local/runtime
pwsh -File tools/start-native-local.ps1 -RepoRoot . -PackagePath data/native-local/runtime -NodePath <official-node-22.23.3-node.exe> -ExpectedCandidateSha <candidate-sha>
```

启动器再次核对 `runtime.json` 和完整 `SHA256SUMS`，只运行该包中的二进制。
`ExpectedCandidateSha` 必填，必须来自已通过门禁的目标 Actions run，不能仅从
下载包自报的 metadata 推导可信候选身份。
Web 仅收到自身签名/会话与必要配置，Alpaca 与 Futu 凭据只传给 Gateway/SDK。
两个服务实际绑定 `127.0.0.1`；已有端口或未知进程占用时拒绝覆盖，不杀其它任务。
启动器先移除当前进程全部继承变量，再传入服务白名单；避免 Windows 的
`Start-Process -UseNewEnvironment` 忽略显式环境块。Actions 通过父进程合成敏感
变量验证 Web 的运行模式隔离，真实凭据不参与该验收。
状态、日志和独立数据库保存在根目录 `data/native-local/`，目录由独占 Windows ACL
保护。旧 SQLite 不迁入、不认领。
ACL 写入仅更新 DACL，不重写 owner 或审计 section；现有 owner 必须是当前
用户，或仅当当前 token 的管理员角色实际启用时为 Builtin Administrators
（Windows 管理员创建对象的默认 owner）。其他 owner 拒绝；写后继续核对
仅当前用户和 SYSTEM 的显式完整控制权限。无需为日志
权限修复请求管理员提升。Actions 日志记录实际 token 上下文，管理员 Runner
的通过不能冒称标准用户 token 验收。
Gateway 的 SDK 子进程仍清空继承环境，仅在 Windows 额外传递操作系统
`SystemRoot`：固定 Node 的 crypto 初始化需要该变量，缺失时可在执行 JS 前
以原生断言退出。该操作系统变量不授予任何 Provider 或签名权限。Windows
Actions 还需检查唯一 SDK 子进程持续存活；无 OpenD 时 disconnected 仍是正确状态。

打开 `http://127.0.0.1:3000`。确认 Gateway `/healthz` 和 Web `/api/healthz` 正常后，
单独查看行情连接状态；HTTP liveness 不代表 Provider 权限、订阅就绪或数据新鲜。
没有本机市场权限的期权继续 unavailable。

## 停止与回滚

```powershell
pwsh -File tools/stop-native-local.ps1 -RepoRoot .
```

停止器只处理状态文件中记录且 PID/创建时间一致的本任务进程。保留数据库、
日志与 `.env`，不删除私有状态。替换运行包时先停止，再选择另一个已验证 commit
的包；数据格式不兼容时保留原目录并使用独立数据目录，不覆盖旧终端数据。
`runtime.json` 的 `LOCAL_EVALUATION_ONLY` 和 `NOT_CLAIMED` 不代表生产或许可放行。
