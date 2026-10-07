# 部署与运行

## 本机 Compose

```bash
cp .env.example .env
# 编辑 .env，按下面的认证配置说明设置变量
docker compose config --quiet
docker compose up --build --wait
```

默认浏览器入口为 `http://127.0.0.1:3000`，Gateway 本地诊断端口为 `http://127.0.0.1:8080`。可用 `EQO_TERMINAL_HOST_PORT` 和 `EQO_GATEWAY_HOST_PORT` 更换宿主端口；两者仍只绑定 loopback。research Node API 只在 Compose 网络的 4000 端口监听，不发布到宿主机。terminal 与 research 共用同一 OpenTerminal runtime image，通过各自明确的 service command 运行；Gateway 是独立 Rust image。

默认 compose 运行在本机 Docker 网络，不是面向公网的部署配置。公网入口应由 TLS 反向代理只转发到 OpenTerminal BFF，并确保 Gateway/Node 服务不被公开。不要将 `EQO_BIND` 改为公网接口或额外发布 Gateway/Node 端口。`compose.offline.yaml` 是内网隔离验证 overlay：Compose `internal` network 下宿主端口映射不可用于浏览器访问，服务间/容器内验证才适用。

## OIDC 与服务身份

登录依赖一个固定的 OIDC issuer，issuer 必须是 HTTPS；本机测试可以用 loopback HTTP。Provider discovery 地址为 `${EQO_OIDC_ISSUER}/.well-known/openid-configuration`，客户端应允许 Authorization Code + PKCE/state，并登记精确回调地址：

```text
${EQO_PUBLIC_ORIGIN}/api/auth/callback/eqo-oidc
```

`EQO_PUBLIC_ORIGIN` 与 `NEXTAUTH_URL` 必须是浏览器访问的同一 origin（协议、主机、端口都相同）。非 loopback 环境必须 HTTPS。OIDC profile 需提供 `sub`；权限来自经过 issuer 验证的 `roles` claim，只有以下角色会被接受：

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

## 行情与 readiness

`ALPACA_KEY` / `ALPACA_SECRET` 只注入 Rust Gateway 容器。无凭据时服务保留健康和只读页面，但 SIP/OPRA API 返回明确不可用状态；不得用 Yahoo、IEX、mock 或 indicative 数据替换并标成 SIP/OPRA。真实市场数据状态需单独核实账户 entitlement 与实际上游返回。

| Probe | 含义 |
|---|---|
| Gateway `/healthz` | 进程可响应，不代表身份或行情可用 |
| Gateway `/readyz` | Gateway 验证主体所需的独立 signing key 已配置；响应另列 `market_data_ready`，本版本恒为 `false` |
| OpenTerminal `/api/healthz` | Next 进程可响应 |
| OpenTerminal `/api/readyz` | OIDC、会话及委托配置齐全；没有 OIDC 时返回 503，受保护 BFF 不访问下游 |
| research `/readyz` | Node 服务身份 key 与委托验证配置齐全；该 endpoint 不发布宿主端口 |

`docker compose up --wait` 使用容器 healthcheck 等待进程健康。应用 readiness 有意独立于 liveness；启动成功或 `/healthz` 返回 200 不能作为身份、市场数据或交易能力的证据。当前 `execution_enabled` 固定为 `false`，Paper submit 会 blocked 且不会调用券商，Live 始终拒绝。

## 容器布局与验证

容器以非 root 用户运行并启用只读 root filesystem。Gateway 的审计数据使用 `eqoboard-audit` named volume；OpenTerminal Next cache 使用 `openterminal-next-cache`；research 本地 portfolio 数据使用 `openterminal-data`。维护/迁移前先对数据 volume 做一致性备份；本地旧 portfolio 的 `local` owner 不会自动转给首个 OIDC 用户。

运行真实容器、mock 身份服务、路由边界与浏览器验收：

```bash
bash tools/container-e2e.sh
```

此脚本会用专属 Compose project 和临时 env file，清除继承的 Alpaca/OIDC/service secret 环境变量，使用仅供测试的身份 key 和 loopback mock，不读取真实市场 key、不向 broker 下单。脚本输出实际 image ID、entrypoint/command、端口映射、运行用户、rootfs 权限、health/readiness、重启和 cache volume 重建结果，并通过 Playwright 驱动生产模式 Next 容器。失败时会先输出本次 Compose logs，再清理该专属 project 与 volumes。

`E2E_ONLY=1` 只运行末尾生产模式浏览器阶段，供本地定位时使用；它不替代完整脚本，也不应在 CI 配置。离线 network overlay 配置可单独校验：

```bash
docker compose -f compose.yaml -f compose.offline.yaml config --quiet
```

## 配置变更与回滚

升级前保存当前 `.env` 与 Docker image IDs，并备份三个 named volumes。镜像按仓库 Dockerfile 从锁定的 Cargo/npm lockfile 构建；回滚时恢复之前已记录的镜像标签和 volume 备份，再以同一组 Compose 文件启动。认证密钥轮换应先安排重新登录与 SSE 重连：改 OIDC issuer 会使旧 issuer 会话失效，改 signing key 会使旧委托 token 失效。不要为恢复可用而重新启用静态 bearer token 或交易提交。
