# 部署与运行

## 本机 Compose

```bash
cp .env.example .env
# 编辑 .env，按下面的认证配置说明设置变量
docker compose config --quiet
docker compose up --build --wait
```

默认浏览器入口为 `http://localhost:3000`，必须与 `EQO_PUBLIC_ORIGIN` 和 `NEXTAUTH_URL` 的本机默认值保持一致；Gateway 本地诊断端口为 `http://127.0.0.1:8080`。可用 `EQO_TERMINAL_HOST_PORT` 和 `EQO_GATEWAY_HOST_PORT` 更换宿主端口；两者仍只绑定 loopback。research Node API 只在 Compose 网络的 4000 端口监听，不发布到宿主机。terminal 与 research 共用同一 OpenTerminal runtime image，通过各自明确的 service command 运行；Gateway 是独立 Rust image。

默认 compose 运行在本机 Docker 网络，不是面向公网的部署配置。公网入口应由 TLS 反向代理只转发到 OpenTerminal BFF，并确保 Gateway/Node 服务不被公开。不要将 `EQO_BIND` 改为公网接口或额外发布 Gateway/Node 端口。`compose.offline.yaml` 是内网隔离验证 overlay：Compose `internal` network 下宿主端口映射不可用于浏览器访问，服务间/容器内验证才适用。

## OIDC 与服务身份

登录依赖一个固定的 OIDC issuer，issuer 必须是 HTTPS；本机测试可以用 loopback HTTP。Provider discovery 地址为 `${EQO_OIDC_ISSUER}/.well-known/openid-configuration`，客户端应允许 Authorization Code + PKCE/state，并登记精确回调地址：

```text
${EQO_PUBLIC_ORIGIN}/api/auth/callback/eqo-oidc
```

`EQO_PUBLIC_ORIGIN` 与 `NEXTAUTH_URL` 必须是浏览器访问的同一 origin（协议、主机、端口都相同）。非 loopback 环境必须 HTTPS。OIDC profile 需提供 `sub`；权限来自经过 issuer 验证的 `roles` claim，只有以下角色会被接受：

OpenBB research runtime 还必须设置 `EQO_TERMINAL_PUBLIC_ORIGIN`，指向主终端的精确 origin，并与 research runtime 的 `EQO_PUBLIC_ORIGIN` 使用不同 hostname。Cookie 的 host-only 隔离不区分端口，因此 `terminal.example:443` 与 `terminal.example:8443` 不能作为两个安全边界；缺少该配置或 hostname 相同时 research readiness 返回 503。实际 OpenBB 部署必须使用独立 research hostname，且研究服务不得持有终端 Gateway signer 或 Node API key。

Research-mode Next runtime 也会因任一非空 `ALPACA_KEY` 或 `ALPACA_SECRET` 而返回未就绪；市场凭据只由 Rust Gateway 持有。部署研究 BFF 时只映射其 OIDC 配置、独立 session/research signer 和 Gateway URL，不使用整份 `.env` 文件注入容器。

OpenBB 反向代理使用内部 `/api/research/auth-check` 子请求校验登录和 `market:read` role：成功时返回 204、匿名时 401、role 不足时 403，且不签发 Gateway token。部署配置必须将该路径设为内部代理调用且不允许用户直接访问。页面导航可把 401 导向 OIDC 登录；`/api/` 数据请求应保留 JSON 401/403，不能重写为登录 HTML。传给 Lite 的请求必须清除 Cookie 并保留其原生 `Authorization` bearer；Research session cookie 只供 BFF 与内部 auth-check 使用。

## 可选原生 OpenBB Lite Compose profile

`compose.openbb.yaml` 增加独立的 `openbb` profile：固定上游的原生 Lite Workspace、隔离的 Research Next BFF 和受控 Nginx ingress。默认 `docker compose up` 不启用它；启用 profile 不替换主 OpenTerminal，也不使用 `compose.e2e.yaml` 中的 Node mock Gateway。Lite 的 3000 端口只在 Compose 网络内可见，`/data` 使用单独的 `openbb-data` volume，外部入口默认只绑定 `127.0.0.1:8088`。Lite `/api/health` 仅是进程探针，BFF `/api/readyz` 检查 research 身份配置，二者都不代表行情已连接。

为启用本机 profile，在 `.env` 中设置独立的 `EQO_OPENBB_NEXTAUTH_SECRET`、已有 Gateway 验证所需的 `EQO_RESEARCH_JWT_SECRET`、research OIDC issuer/client，以及 `OPENBB_ADMIN_EMAIL` 和 `OPENBB_ADMIN_PASSWORD`。Research BFF 只投影 research 模式需要的变量，不读取整份 `.env`，也不接收 Gateway signer、Node API key 或 Alpaca 凭据。`EQO_RESEARCH_PUBLIC_ORIGIN` 默认使用 `http://127.0.0.1:8088`；如果更改宿主端口，或用于部署环境，必须同步设置成用户实际访问的精确 origin。Research origin 与主 Terminal 的 `EQO_PUBLIC_ORIGIN` 必须使用不同 hostname；HTTP 仅允许精确 loopback hostname，公网使用 HTTPS。OIDC 客户端需登记该 origin 下的 `${EQO_RESEARCH_PUBLIC_ORIGIN}/api/auth/callback/eqo-oidc` 回调。主 Terminal 的 Research 导航只在 `EQO_RESEARCH_PUBLIC_ORIGIN` 显式设置且通过 origin 校验后显示。

profile 的 Lite 登录仍是上游原生邮箱/密码登录，OIDC 只控制是否可进入 Research hostname，不构成 OpenBB SSO。管理员凭据和 Research OIDC 会话互不替代。ingress 将 `/api/auth/*`、health/readiness 与精确 OpenBB BFF 路径送往 Research Next；所有其他 Lite 页面、静态文件和 API 都先经过内部 `auth_request`。匿名页面转到 OIDC 登录，匿名 API 保持 JSON 401，缺少 market-reader role 返回 403。转给 Lite 的请求清除 Cookie，只允许其原生 `Authorization` bearer；浏览器中的 Research session cookie 只送至内部 auth-check 与 BFF。ingress 为请求体大小、客户端读入、代理连接和读写设置了明确上限。

本机启动命令：

```bash
docker compose --profile openbb build
docker compose --profile openbb up --build --wait
```

These commands build the locked source locally. The full-identity Compose tag
selects the source and recipe; it does not guarantee immutable image bytes.
For an approved published image, set `EQO_OPENBB_LITE_RELEASE_IMAGE` to
`eqoboard/openbb-workspace-lite@sha256:<64-hex-digest>` and run
`tools/openbb/openbb-release-compose.sh up`. The wrapper validates the full
repository digest, exports only its 64-character digest to the release-only
overlay, pulls the exact reference, and confirms Docker reports it before
starting Compose without a build section. Invoke the overlay through this
wrapper so a mutable tag cannot replace the digest-pinned image. This repository
has not published a release image, so the opt-in release command must not be
given a tag or an unverified digest.

停止 profile 服务时，主 Terminal、Rust Gateway 和既有 research Node 服务继续运行：

```bash
docker compose --profile openbb stop openbb-research-ingress openbb-research-bff openbb-lite
```

Compose 的本地 image tag 只用于选择构建 recipe，不能当作不可变 artifact digest。正式部署/回滚必须记录实际 OCI manifest digest 和可恢复镜像归档或 registry RepoDigest。attempt-22 在冻结代码 `00f7aec59c6a4e67e568c9b7de8a6afb4f37fa41` 上以 no-skip 流程完成默认 profile build/up、全部六个 profile service health、真实 Rust Gateway 与 native Lite 浏览器矩阵、core-only、Gateway offline/restart、错误镜像 unhealthy 检测与原 image 恢复；`runtime-result.json` 记录 `default_profile_smoke_executed=true` 与 `cleanup_verified=true`。这是本地 loopback 协议 mock 验收，市场行来源为 `unknown`，未验证真实 Alpaca entitlement；没有下单、registry 发布或部署。当前 release gate 仍未批准，OCI index/manifest/config、runtime SBOM 与源码/recipe 身份见 [OpenBB supply-chain runbook](OPENBB_SUPPLY_CHAIN.md) 和 [本地验收记录](evidence/openbb-local-runtime-acceptance.json)。

| OIDC role | 授权范围 |
|---|---|
| `eqoboard-market-reader` | 行情读取/订阅/流、研究读取、workspace 读取 |
| `eqoboard-workspace-editor` | workspace 写入 |
| `eqoboard-order-reviewer` | 订单预览 |
| `eqoboard-paper-operator` | Paper submit action（当前 Gateway 仍固定返回 blocked） |

三个签名 secret 必须互不相同：`NEXTAUTH_SECRET` 至少 32 字符；`EQO_GATEWAY_JWT_SECRET` 与 `EQO_RESEARCH_JWT_SECRET` 各至少 64 个可打印字符。另为 `EQO_RESEARCH_API_KEY` 生成至少 32 字符的独立服务密钥。使用密码管理器保存。生成 key 的例子：

```bash
openssl rand -hex 32
```

分别生成独立值填入 `.env`。Gateway key 仅由 Next 和 Rust Gateway 使用；research key 由 Next、research Node 与 Gateway 验证使用，Node 只能签 `market:read` 子 token。不要把任何 secret 放在 `NEXT_PUBLIC_*`、浏览器请求头或仓库中。旧 `EQO_ACCESS_TOKEN` 不再是认证方式。

`EQO_SESSION_TTL_SECONDS` 是滚动会话空闲期限，默认 3600 秒，允许范围 5 到 86400 秒。SSE 每次连接绑定当次签名会话及委托期限，期限到时断开；浏览器需重新授权连接，不能延长已建立流的凭证。写请求要求浏览器 Origin 与配置的 public origin 完全匹配，JSON 不超过 64 KiB，body 最长读取 5 秒。

### MDP 归档 read API

`EQO_MDP_URL` 配置只读 MDP 服务 origin；留空时 `/api/eqo/market-data/datasets/{dataset_id}/bars` 返回不可用，不访问下游。当前仓库 Compose 不启动 MDP 服务。若 MDP 与 BFF 加入同一私有 Compose 网络，固定服务名使用 `market-data-platform`，可设置 `http://market-data-platform:8088`；其它非 loopback 地址必须使用 HTTPS。服务不得公开到浏览器或公网，部署时应限制在 BFF 可达的私有网络。

MDP 服务委托 key 与 Gateway key 完全分开。终端只接收 `MDP_TERMINAL_JWT_SECRET`；`compose.openbb.yaml` 的 research BFF 只接收 `MDP_RESEARCH_JWT_SECRET`。分别生成独立的至少 32 字节随机值（建议 `openssl rand -hex 32`），不得与彼此、NextAuth 或 Gateway signing key 重用。BFF 签发的 MDP JWT 固定 audience `lqepoch-market-data`、`scope=[market:read]` 和最多 60 秒期限；kid/issuer 映射分别为 `mdp-terminal` / `eqoboard-openterminal` 与 `mdp-research` / `openterminal-research`。

当前 BFF 针对 MDP revision `f7e21beb79e125bfaeaca09bda95639cd89faaea` 的 V1 只读 API；它只允许 `diagnostic` bars，并以 Core 注册的 `lqepoch.us_equity_trade_bar_1m.v1` schema 指纹验证响应。V1 不含 completion qualification，`curated` 会在请求 MDP 前拒绝。归档 API、BFF 身份 readiness 和 Gateway `/readyz` 都不证明真实 SIP/OPRA 授权、行情连接、exchange calendar 或交易能力。

### 注册预测只读 API

`EQO_QUANT_RESEARCH_URL` 配置只读 Quant registry origin；留空时 `/api/eqo/research/predictions/{run_id}` 返回不可用且不访问下游。允许 HTTPS、精确 loopback HTTP 开发 origin，或私有 Compose DNS `quant-research` 的 HTTP。当前 Compose 不启动 Quant 服务；若将来加入，固定服务名为 `quant-research`，服务只在 BFF 可达的私有网络内，浏览器不得直连。

只有受信 OIDC `eqoboard-private-research-reader` role 可读取注册预测；`eqoboard-market-reader` 和通用 `research:read` 不授予此能力。终端 BFF 只持 `QUANT_TERMINAL_JWT_SECRET`，OpenBB research BFF 只持 `QUANT_RESEARCH_JWT_SECRET`。二者各自生成至少 32 字节随机值，与彼此、NextAuth、Gateway、MDP、OIDC client secret 及其他服务 key 都不同。短时委托固定 audience `lqepoch-quant-research`、唯一 scope `research:private-read`、TTL 最多 60 秒；终端使用 `iss=eqoboard-openterminal` / `kid=quant-terminal`，research 使用 `iss=openterminal-research` / `kid=quant-research`。不配置对应 key 或上游 origin 时功能保持不可用，不提供旧 key 回退。

路由只接受固定 Quant GET 路径和单个合法 `run_id`，不接受调用者提供 origin、查询参数或请求体；关闭 redirect、限制响应大小并校验完整 schema/assessment/hash。浏览器只收到公开 ProtoJSON 投影和只读 assessment，不收到 `private_artifact_sha256` 或 private envelope。即使本地 registry 返回预测，UNKNOWN 的来源完整性/有限输入回执/point-in-time 状态仍保持 UNKNOWN，`promotion_allowed` 始终为 false；此接口不是研究资格或交易授权证明。

### Trading Engine 离线预览

可选 OpenTerminal widget 通过同源 `/api/eqo/engine/status` 和 `/api/eqo/engine/preview` 读取 Engine API。默认 Compose 不启动交易引擎，也不配置 Engine URL/key；因此功能默认 unavailable。`EQO_ENGINE_URL` 仅允许精确 loopback HTTP origin `http://127.0.0.1:<port>`，Engine 必须继续绑定 loopback，且与 Next BFF 共享 host/network namespace。标准拆分容器无法通过自身 `127.0.0.1` 访问另一容器，不能把 Docker service DNS 或 `0.0.0.0` 当作 Engine 接入方案。

只有受信 OIDC role `eqoboard-engine-offline-reader` 可用该功能。终端配置独立 `ENGINE_TERMINAL_JWT_SECRET`，与 OIDC、NextAuth、Gateway、MDP、Quant、market/provider key 都不同，并与 Engine owner-only delegation key 文件内容一致；不可把 key 注入 `compose.openbb.yaml` 的 Research runtime。委托固定 `iss=eqoboard-openterminal`、`kid=engine-terminal`、`aud=lqepoch-trading-engine`、scope 字符串 `engine:offline-read`、最长 60 秒。BFF 只调用固定 GET status/preview 路径，禁止 redirect，响应上限 16 KiB，deadline 3 秒。status 与 preview 是分开 best-effort 读取，不构成同一时点快照。

该界面只消费 Engine 的合成 offline projection，始终显示 `synthetic_offline`、`source unknown`、非事务性与执行/订单 mutation disabled。它不能证明真实账户、券商、行情、风险预留、持久恢复或执行能力；本地联调只使用合成 mock/数据。

## 行情与 readiness

`ALPACA_KEY` / `ALPACA_SECRET` 只注入 Rust Gateway 容器。无凭据时服务保留健康和只读页面，但 SIP/OPRA API 返回明确不可用状态；不得用 Yahoo、IEX、mock 或 indicative 数据替换并标成 SIP/OPRA。真实市场数据状态需单独核实账户 entitlement 与实际上游返回。

| Probe | 含义 |
|---|---|
| Gateway `/healthz` | 进程可响应，不代表身份或行情可用 |
| Gateway `/readyz` | Gateway 验证主体所需的独立 signing key 已配置；响应另列 `market_data_ready`，本版本恒为 `false` |
| OpenTerminal `/api/healthz` | Next 进程可响应 |
| OpenTerminal `/api/readyz` | OIDC、会话及委托配置齐全；没有 OIDC 时返回 503，受保护 BFF 不访问下游 |
| OpenTerminal MDP bars BFF | 单次 diagnostic archive query；缺 MDP key/origin 时返回 503，不表示持续采集或行情已连接 |
| research `/readyz` | Node 服务身份 key 与委托验证配置齐全；该 endpoint 不发布宿主端口 |

`docker compose up --wait` 使用容器 healthcheck 等待进程健康。应用 readiness 有意独立于 liveness；启动成功或 `/healthz` 返回 200 不能作为身份、市场数据或交易能力的证据。当前 `execution_enabled` 固定为 `false`，Paper submit 会 blocked 且不会调用券商，Live 始终拒绝。

### 本机只读行情诊断

公共 GitHub Actions 不运行真实行情请求。获准操作者可在受控的本机 shell 中用 `ALPACA_KEY` / `ALPACA_SECRET` 显式运行 `python3 tools/check_alpaca_feeds.py` 或 `python3 tools/qqq_sip_quota_probe.py`；它们只发只读 GET。历史导出入口为 `python3 tools/qqq_sip_weekly_export.py --week 2026-W01 --out <仓库外的受限目录>`，仅覆盖脚本列出的 2026 年日期范围。导出的 Parquet 含受数据许可约束的市场记录，目录必须留在仓库外，且不得提交、上传 Actions artifact 或向 Drive 发布。该操作不会执行下单；本仓库 CI 不验证真实 entitlement，也不代表账户当前配额。

## 容器布局与验证

容器以非 root 用户运行并启用只读 root filesystem。Gateway 的审计数据使用 `eqoboard-audit` named volume；OpenTerminal Next cache 使用 `openterminal-next-cache`；research 本地 portfolio 数据使用 `openterminal-data`。维护/迁移前先对数据 volume 做一致性备份；本地旧 portfolio 的 `local` owner 不会自动转给首个 OIDC 用户。

Portfolio API 对每个已验证主体限制每分钟 120 次，并对单个 research 进程内所有主体合计限制每分钟 1200 次。该限额使用进程内 memory store；多实例或多 worker 部署前须接入共享限流 store，或由可信 API ingress 提供等价的主体级与服务级限制。

运行真实容器、mock 身份服务、路由边界与浏览器验收：

```bash
bash tools/container-e2e.sh
```

此脚本会先在 Compose 启动前运行三个开发态预览/订单边界 smoke，再使用专属 Compose project 和临时 env file；Docker Compose 清除继承的 Alpaca/OIDC/service secret，host 侧 Playwright、mock server 和开发态 Next 进程只通过 `env -i` 接收测试所需 allowlist。它使用仅供测试的身份 key 和 loopback mock，不读取真实市场 key、不向 broker 下单。脚本输出实际 image ID、entrypoint/command、端口映射、运行用户、rootfs 权限、health/readiness、重启和 cache volume 重建结果，并通过 Playwright 驱动生产模式 Next 容器。失败时会先输出本次 Compose logs，再清理该专属 project 与 volumes。

生产 Next 容器的浏览器阶段也会运行 `compose.e2e.yaml` 中的本地 MDP HTTP mock：容器只访问 loopback `E2E_MDP_PORT`（固定 14313），并使用 overlay 内独立的 MDP 测试 signer key。`tools/container-e2e.sh` 会清除宿主传入的 MDP origin、端口与 signer 变量，避免覆盖隔离配置。该 mock 只返回合成 fixture，不启动真实 MDP、rclone、Drive 或行情连接；它验证的是生产 Next BFF/容器路径，不是外部存储连通性。

同一隔离 overlay 的 Quant mock 只返回合成的 `LOCAL_REGISTERED_ROOT` 测试视图，使用专属 Quant 测试 signer 和 loopback `E2E_QUANT_PORT`（固定 14314）。它不启动真实 Quant registry，不读取研究产物或 finite receipt；生产 BFF/UI测试只证明受信 OIDC role 到短时只读委托的容器路径。

`E2E_ONLY=1` 保留开发态 smoke 和末尾生产模式浏览器阶段，但跳过前面的生产 readiness/restart/cache-volume 检查，供本地定位浏览器问题时使用；它不替代完整脚本，也不应在 CI 配置。离线 network overlay 配置可单独校验：

```bash
docker compose -f compose.yaml -f compose.offline.yaml config --quiet
```

开发态市场流用例可单独延长 OIDC-backed session，避免较慢的多标签页/确认流程撞上默认 30 秒到期：

```bash
cd apps/openterminal
E2E_SESSION_TTL_SECONDS=120 npm run test:e2e -w web -- --grep market-stream.spec
```

测试环境默认 TTL 仍为 30 秒；会话过期与 SSE 到期用例须用默认值运行，不能使用延长配置代替过期边界验收。

## 配置变更与回滚

升级前保存当前 `.env` 与 Docker image IDs，并备份三个 named volumes。镜像按仓库 Dockerfile 从锁定的 Cargo/npm lockfile 构建；回滚时恢复之前已记录的镜像标签和 volume 备份，再以同一组 Compose 文件启动。认证密钥轮换应先安排重新登录与 SSE 重连：改 OIDC issuer 会使旧 issuer 会话失效，改 signing key 会使旧委托 token 失效。不要为恢复可用而重新启用静态 bearer token 或交易提交。
