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
EQO_LOCAL_CORE_BARS=false
EQO_LOCAL_ALPACA_HISTORY=false
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

原生 Chart 的 Core Bars 通过独立 MDP 服务，不能仅凭 Quotes 可读认定历史图表可用。
启用本机历史需将 `EQO_LOCAL_CORE_BARS=true`、`EQO_MDP_URL=http://127.0.0.1:8088`
以及两个独立的 `MDP_TERMINAL_JWT_SECRET` / `MDP_RESEARCH_JWT_SECRET` 配入根 `.env`。
本机启动器要求每把 key 至少 64 个无空格 ASCII 字符，建议独立 CSPRNG 生成的 64 hex；
不可与 Gateway、NextAuth、其它 signer 或 Provider 凭据共用。Web 只拿 terminal key，
MDP verifier 只拿这两把 MDP key，不拿 Gateway signer 或 Futu key。

真实查询还需成对设置 `MDP_MARKET_CALENDAR_FILE`（私有 `data/native-local` 下的绝对路径）
和 `MDP_MARKET_CALENDAR_SHA256`。使用固定 MDP 的 `tools/xnys_snapshot_adapter.py`，
从操作者持有且单独固定原始哈希的 XNYS artifact 离线转换；保留原始来源、canonical checksum、
官方验证范围和输出 SHA。Windows 转换需要独立校验的 IANA timezone 数据。禁止把测试日历
当作真实日历。缺少日历时服务可提供存活/鉴权诊断，但 history 明确 unavailable。
当前 CLI 只加载现金市场日历，没有 OVER/BOATS overnight authority。

默认本机 MDP 只通过已有 Gateway/Futu 读取历史，受现行 NEW/BUFFER 策略约束；
OLD 或未知时段仍留缺口。若显式设置 `EQO_LOCAL_ALPACA_HISTORY=true`，启动器仅把
已配置的 `ALPACA_KEY` / `ALPACA_SECRET` 传给 MDP 现有只读历史客户端，按现行服务端
路由尝试 SIP 历史；不会修改来源优先级，不证明 Plus/数据权限，不进入 Web 或 Futu worker。
Paper endpoint 不用于历史行情认证，不启用订单。Windows 不设置 MDP 市场 Parquet cache；
独立空 LocalTest 根和 query-cache 仅用于服务初始化，不表示 Windows 归档读取已支持。

本机身份只在显式启用、IPv4 loopback 绑定、Host/Origin/端口及配置一致时有效。
用户归属为独立 local-workstation issuer/subject，不冒称 OIDC。Research runtime
拒绝该模式，公共部署仍使用 OIDC。保留写请求的同源与 Fetch Metadata 校验、
服务端 scope 和独立 signer。拒绝远端 Host、冲突的代理转发头及跨源请求。

## 下载与启动

选择目标 commit 上 **全部 Native Web CI 门禁成功** 的 run。Windows lane 会先
构建 Rust Gateway、固定版本 MDP 和 Next standalone，再对实际运行包执行本机身份、工作区保存、
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
固定 MDP 来源见 `third_party/mdp-runtime.json`；内层源码/文件清单与外层完整清单交叉验证。
MDP 源项目采用 MIT；包内保留其 `LICENSE` 和依赖 `NOTICE.txt`，不将第三方实现
声明为 EqoBoard 原创。该来源记录不能替代整个静态链接闭包或数据商业使用权验收。
固定 MDP 包含失败分段续页修复：近期 Futu 失败页仍保留缺口，若存在旧计划段则提供
`Load older bars` 的续页，继续读取原计划的 Alpaca 历史；不替换失败分段的来源。
空首屏不代表所有旧历史均不可用，所有页读取后仍须保留失败段的 partial/unknown。
Web 仅收到自身签名/会话与必要配置；Futu key 只给 Gateway/SDK，显式启用的 Alpaca
只读历史 key 只给 MDP。启用 Core Bars 时按 Gateway→MDP→Web 启动，端口分别为
8080、8088、3000，均实际绑定 `127.0.0.1`；已有端口或未知进程占用时拒绝覆盖。
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
Futu 历史的 `futu_invalid_response` 表示已接收数据未通过验证，保留 HTTP 502；
`futu_read_failed` 仍表示未分类的读取失败。两者均不暴露 SDK 原始消息或行情，
不能仅凭这些错误推断账户权限；行情快照可读也不证明历史路径成功。

## 停止与回滚

```powershell
pwsh -File tools/stop-native-local.ps1 -RepoRoot .
```

停止器只处理状态文件中记录且 PID/创建时间一致的本任务进程。保留数据库、
日志与 `.env`，不删除私有状态。替换运行包时先停止，再选择另一个已验证 commit
的包；数据格式不兼容时保留原目录并使用独立数据目录，不覆盖旧终端数据。
`runtime.json` 的 `LOCAL_EVALUATION_ONLY` 和 `NOT_CLAIMED` 不代表生产或许可放行。
新状态 schema v2 绑定外层 `SHA256SUMS` 文件的 SHA-256，并逐一核对 PID record；
按 Web→MDP→Gateway 停止。仍兼容 PR65 的 v1 两服务状态，不删除其数据。
回滚到不含 MDP 的旧运行包前，先停服务并将 `EQO_LOCAL_CORE_BARS` 和
`EQO_LOCAL_ALPACA_HISTORY` 明确设为 false；启用 Core Bars 却选择缺少 MDP 的旧包会拒绝启动。
Windows smoke 只证明无真实 Provider/日历时的三服务身份和失败关闭，不是实时行情、
历史数据覆盖、Windows Ctrl-C graceful shutdown 或生产回滚验收。
