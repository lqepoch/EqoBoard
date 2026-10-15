---
name: openbb-workspace
description: 维护 EqoBoard 的 OpenBB Workspace custom backend、widgets.json、apps.json、认证和兼容性。
---
# OpenBB Workspace Skill

使用当前官方 Workspace 文档作为 schema 来源。入口为 Rust Gateway。

- `/widgets.json` 与 `/apps.json` 必须返回规范 JSON。
- Widget endpoint 返回 flat JSON array；AgGrid 配置使用官方 `columnsDefs` 字段。
- 每条 OpenBB market row 必须返回真实来源身份、feed、该市场值自己的 `market_as_of`、分页/截断和 completeness 字段。只在固定 Alpaca API 地址可确认时返回 `source_mode=alpaca`；任意自定义 `EQO_MARKET_DATA_BASE_URL` 保持 `unknown`。缺失的 quote/trade/model 时间保持 null，不得填 Gateway 请求时间。
- bars/options 的 provider `next_page_token` 必须按有界页数消费并返回 `pages_fetched`、`has_more`、`truncated`。只接受缺失/null（终止）或非空字符串（续页）；空字符串及其他 JSON 类型无效。期权 OCC 符号必须可解析且到期日匹配请求，否则整个请求失败关闭。空结果保持空数组，不伪造表格行。
- 若 bars/options 页预算耗尽、仍有后续页而 flat rows 为空，端点返回明确的 502 截断错误；完整空结果仍返回 `200 []`。
- `refetchInterval` 代表普通 HTTP polling，不构成 Live Grid 或 WebSocket 实时证据。只有实现并验证官方 `wsEndpoint` 协议、认证与来源边界后才能声明 Live Grid。
- 日期默认值必须使用 Workspace 支持的动态日期修饰符或留空，禁止在固定 manifest 中写入会过期的合约日期。
- OpenBB Lite 使用独立 research hostname 和隔离的 Next research BFF。`EQO_TERMINAL_PUBLIC_ORIGIN` 必须指向主终端 origin 且 hostname 不同；仅使用不同端口仍会共享 host-only cookie，research readiness 会拒绝这种配置。用户先通过现有 OIDC/NextAuth session 登录，服务端再用独立 research signer 签发最长 60 秒、`kid=research`、`iss=openterminal-research`、`aud=eqoboard-gateway`、单一 `market:read` scope 的委托 JWT。research runtime 不配置终端 Gateway signer、Node API key 或市场密钥，且拒绝非空 `ALPACA_KEY`/`ALPACA_SECRET`；市场凭据只进入 Rust Gateway。
- OpenBB custom source URL 为同源 `/api/openbb`。Pinned Workspace endpoint `openbb/v1/stocks` 等会拼接为 `/api/openbb/openbb/v1/...`；BFF 只映射这三条只读路径，并保留 Gateway 的错误、feed、时间戳和 truncated 元数据。不得从 manifest 描述推断实际 source。
- `/api/research/auth-check` 是反向代理内部的 `auth_request` 端点：market-reader 返回空 204，匿名返回 JSON 401，缺少 market role 返回 JSON 403；它只检查 OIDC 会话，不签发 Gateway token。公网 ingress 必须仅在内部子请求位置使用它，不能把该路由作为普通浏览器/API 路径发布。
- Gateway 委托通过 Authorization header 携带；静态 `EQO_ACCESS_TOKEN` 已退役，不能放宽 Gateway 验证。市场密钥不进入 Workspace。
- Next middleware 不匹配 bounded JSON 写接口或 NextAuth body parser，避免适配器预先克隆未完成请求流导致 route 层大小/超时门禁失效。每个被排除的 handler 必须在读取 body 前拒绝或精确 allowlist research mode，且 research 测试覆盖认证、订单、订阅、portfolio 和 AI 写入口。
- OpenTerminal 的可选原生 Research 导航只读取服务端校验的 `EQO_RESEARCH_PUBLIC_ORIGIN`，在新标签打开独立 UI origin，不转发主终端会话或凭据；unset/非法值隐藏入口。该导航本身不构成 Lite 或 Gateway 认证证据。
- `npm run test:e2e:research --workspace web` 会构建 production Next 并用 OIDC/Gateway/MDP mock 验证隔离 Research BFF 与浏览器，包括市场 role、401/403、路径 allowlist、请求参数、委托期限、响应透传、truncated 和日线窗口/分页。`OpenBB Optional CI` 的 native runtime lane 会运行此合成 BFF 套件，再独立运行 Lite 原生容器/浏览器 E2E；前者不替代真实 Lite ingress、容器或登录验收，也不证明 Yahoo provider 可用性。
- SIP/OPRA endpoint 必须显式检查 feed；失败返回错误，不切换数据源。
- OpenBB 处于 OpenBQ/FINOS 治理迁移阶段，接口兼容层保持薄，业务模型不得绑定 Workspace 内部实现。
- 新增 live_grid 前验证 WebSocket 的认证、Origin 和市场数据再分发边界。
- Lite 社区适配必须从锁定 commit/archive SHA 派生；当前 recipe 只接受 Dockerfile 明确复制并执行的单一 runner/patch/manifest 组合。`tools/openbb/upstream-diff.sh` 只对同一锁定 patch 生成逐文件差异报告，`tools/openbb/patched-source-sbom.sh` 为相同 patched tree 生成独立 source-only SPDX。`build-lite.sh` 使用 owner-private XDG cache 锁跨 worktree 串行化身份/tag 检查和构建，并拒绝覆盖同 identity 的旧 build record；手动 Docker/Compose 构建不参与该锁。`local-buildable` 只允许本地 source/recipe 构建尝试，不代表运行镜像、登录、浏览器 E2E 或部署已通过。
- `local_mock_evidence` 是可选的独立历史证据，不是 release gate。升级 source 或 recipe 时，若旧 passed 记录不再匹配，应删除旧指针或改为 `{ "scope": "local-mock", "status": "pending" }`，不得复制旧记录或把缺失/pending 标成通过。若记录保留为 passed，工具严格核对记录 SHA、冻结测试 commit、OpenBB archive、OpenTerminal commit 和 recipe identity。当前候选的源码、镜像、SBOM、runtime、browser E2E 与 deployment 门槛分别验收；本地 build 不得用于填充或替代这些验收证据。
- OpenBB Lite 的 CI 验收由 `.github/workflows/openbb.yml` 独立负责。PR/push 上的轻量路由与稳定 `OpenBB optional validation gate` 每次都运行；source/recipe 或共享 research 集成改动触发所需的 source SBOM/drift 与原生 Lite runtime/E2E lane。手动触发及每周计划运行完整两条 lane；无法可靠计算改动范围时 fail closed 并执行重型验收。核心 CI 不负责构建 OpenBB Lite。
- OpenBB 的源码校验、上游及 patched-source SBOM、runtime 镜像构建与浏览器/容器 E2E 的权威验收记录必须来自 `OpenBB Optional CI` 的 GitHub Actions run，并与候选 commit/run attempt 绑定。当前 workflow 不生成镜像 SBOM，也不批准 release 或部署；正式发布的镜像 SBOM、runtime acceptance 和 deployment 门槛仍需分别补齐。 本地 Compose/helper 构建只供开发调试，不得作为 CI、release 或部署证据；不得把本地 mock 记录复制到新源码/recipe identity。
