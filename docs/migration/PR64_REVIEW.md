# PR #64 源码审查与验收差距

审查日期：2026-10-16（Asia/Singapore）。原候选
`c0e22628249b8b2e946c13d7d28ed0c949ad9702`，远程 main 基线
`599812beb1789d04061496025f5d502a8bd4900c`。

结论：独立原生终端已经有实际实现及合成容器测试，尚不能认定原始需求的
“全面迁移、完整切换、长期自主运行”已跑通。PR 继续作为候选，不能把 CI
成功等同于全量功能、真实数据、许可与生产验收完成。

## 已核实的证据

- [Native run 38729250483](https://github.com/lqepoch/EqoBoard/actions/runs/38729250483)
  绑定原候选 SHA；app、生产镜像、类型、lint、格式、310 单元/路由和 SBOM
  步骤成功。已下载其实际产物；Playwright JSON 为 26 expected、0 unexpected、
  0 skipped、0 flaky。原候选的 core、OpenBB 及四类 CodeQL 分析均成功。
- Gateway fixture 的快照/期权/bars 是空结果，SSE 只发送 comment；因此这
  26 项不能证明 Quote、Options 或 Tape 的非空内容交互跑通，更不能证明
  SIP/OPRA/Futu 的真实来源、权限、覆盖及新鲜度。
- 同一产物的 `native-license-audit.json` 中 runtimeNoticeGate 仍 BLOCKED：
  SWC 静态依赖 notices、最终镜像原生二进制许可闭合、client/server-only
  标记包来源及完整许可证。镜像 SBOM 成功不是这些条件已解决。
- `compose.yaml` 继续是旧默认部署；`compose.native.yaml` 是显式 opt-in，
  app-only Docker context 不导入旧应用。旧目录仍保留；没有执行归档移动。
- `platform-ops#20` 当前仍是 open Draft，未合并；不能把九仓候选当成现行
  契约。OpenBB Workspace 官方仓库目前 archived；OpenBB 数据平台仓库
  重定向至 `openbq-org/OpenBB`。本次不升级其已固定源码版本或引入依赖。

## 本次代码审查修复

1. **期权市场时间混淆**：`OptionsWidgets.tsx` 在 `event_time` 缺失时把
   `received_at` 放进 Event time 列。现在缺失市场时间显示 unknown，接收
   时间单列显示；相邻单元测试覆盖两种时间独立、缺失及同时存在。
2. 新增固定、明确标注 synthetic 的测试控制场景，经生产 BFF 的共享 SSE
   到真实 AG Grid Tape，检查非空行、缺失市场时间、代次切换清除旧行和
   单连接。该 fixture 没有真实服务连接，不改变应用的行情来源或执行权限。

3. **只读工作区导航失效**：只读用户切换工作区或标签会被写权限检查拒绝。
   现在只更新本地选择，不变更服务端数据、revision 或 dirty 状态；写者仍走
   CAS 保存。测试断言只读切换成功且 `repository.save` 未调用。
4. **导入活动工作区丢失**：克隆导入文档原来强制选第一项，现在按源 ID
   映射保留活动项；增加第二项为活动工作区的回归。模板界面也明确只保存
   当前 tab，避免把单 tab 模板描述成完整 workspace 模板。
5. **OIDC 配置未闭合**：原来缺失 `NEXTAUTH_URL` 仍可判为已配置。现在必须
   显式等于精确 `EQO_PUBLIC_ORIGIN`，否则认证不可用。测试覆盖缺失、错配、
   额外路径/凭据、正确 HTTPS 和本机 origin；不是关于现行部署可被利用的断言。
6. **Futu 快照不可显示**：真实 Gateway 的 Futu envelope 没有 `source`，
   原生 decoder 却只放行 `source=alpaca`。现在识别现行 Futu 顶层和逐行
   feed/source_mode/label，保留 unknown entitlement、32 行上限及原始 wire。
   不把通用 `source_mode=alpaca` 或自称 Futu 的任意对象提升为受支持来源。
   回归包括当前 Futu 格式、来源不符、过量行和接收/市场时间分离。Alpaca
   现行 Rust 路由确实带 `source=alpaca`，其原路径保留。
7. **连续历史刷新累积无界**：旧逻辑反复合并前一刷新后的全量 bars，页数
   上限无法限制不断产生的新时间点。现在从固定 cursor 页链重建，再叠加
   最新 head；保留精确请求窗口和重叠行优先级，清除已离开当前 head 且
   不属于固定页链的旧行。新测试覆盖连续窗口移动；这不是负载性能资格证明。
8. **浏览器租约顺序与股票容量**：共享宿主读取并校验 Gateway 容量、固定
   股票集合，容量未知时不请求股票租约；保留固定项所占容量，50 项 Watchlist
   仅读取已被租约选中的子集，并显示 Partial/未覆盖数量。报价与期权标的
   的首次读取等待 HTTP ACK。Gateway 实例变化时重读容量、重新租约；状态
   读取有 5 秒 deadline 和至多一次重试，不响应 abort 的请求也不会永久 pending。
   单元回归覆盖未知容量、50/32 部分覆盖、排在末尾的固定项、实例重启及超时。

**Futu 仍有实质未完成项**：Gateway `stock_subscribe` 在写入 watch channel
后立即返回 HTTP ACK；Futu SDK watcher 的实际订阅更新是异步的。上述修复
不能保证 worker 已完成更新，新标的首个快照仍可能 `subscription_required`。
目前客户端错误分类不足以安全区分该窗口与鉴权/限流/真实故障，因此没有用
通用自动重试掩盖问题。需要 Gateway/worker 同步或精确 ready/error 契约和
受控 Provider 回归；HTTP ACK 仍不宣称 provider 确认、entitlement 或 freshness。

上述回归需在新候选 Actions 验证，未执行的测试不记为通过。

修复候选 `1e9bd31703ae7aee1271850dc838d29acbfe34ac` 的
[Native run 38835087755](https://github.com/lqepoch/EqoBoard/actions/runs/38835087755)
已有真实产物：90 个文件、326 单元/路由测试通过，类型、lint、格式、密钥
扫描、生产构建、生产镜像和 SBOM 成功；浏览器为 24 passed、3 failed，
0 skipped / flaky，故整体失败。非空 Tape 的 trace 实际已有成交行，失败
来自测试引用 AG Grid 新版本已不存在的 CSS 容器类名；恢复测试在异步
IndexedDB 列表返回前读取 options。后续只改用行/单元格角色定位、等待指定
delete 恢复项，不降低数据、时间、代次或恢复断言。Yahoo MAX 分页的最后
一页返回 200 但 trace 标记 `net::ERR_ABORTED`；尚无产品触发取消的确证。
测试现在在 response 到达时立即等待完整 transfer 并读取正文，与点击并行
等待，保留全部相邻窗口、cursor、来源及次数断言；未加入重试或吞掉取消。
若仍失败，必须继续定位，不能将该改动直接计为已修复。最终候选仍须重跑。

运行时许可补充审查确认：原候选 image SBOM 未列 SWC native 候选包或
server-only，却列出 client-only manifest、Node 和 better-sqlite3 native
文件。部分 native 文件的 SPDX SHA1 为全零，不能当成真实文件身份。新增
Actions-only 原生文件清单工具，在同一 image config digest 的无网络、只读、
无宿主挂载容器里读取实际字节并生成 SHA-256/大小，绑定 receipt 和校验清单。
它不执行扫描到的模块，也不把文件哈希冒充许可证、来源或静态嵌入组件证明。
许可 BLOCKED 保留；新清单本身仍需新 head 的 Actions 验证。

`1e9bd31` 的实际清单已生成并与 receipt / SHA256SUMS 一致：703 项、
702 个唯一 SHA-256、209,380,936 字节（699 ELF、2 Mach-O、2 PE），其中
8 项是 better-sqlite3 的跨平台预编译模块。102 个 symlink 被明确跳过，
不是完整文件系统扫描证明。此精确镜像的 SWC 两个 native 包与 server-only
未在 SBOM/扫描路径中发现；client-only 仍存在，完整权威许可文本尚未闭合。
这些观测不自动修改未来候选的许可门槛；原生组件的来源、构建与静态嵌入
组件 notices 仍需补证，不能把新哈希清单当作许可放行。

首轮修复候选 `ac310a18685c8cfa458644a1cb41ced58e2cb617` 的
[Native run 38832905619](https://github.com/lqepoch/EqoBoard/actions/runs/38832905619)
失败记录保留：history 测试旧夹具缺少新增 projection 字段，三处格式不符，
两条既有订单测试的固定合约在测试当天到期。后续提交修正夹具类型、按 Actions
格式提案修正源码格式，并冻结订单测试时钟，额外断言同一合约在到期当天及
之后仍被拒绝；未更改生产的过期拒绝逻辑。生产 build/浏览器在该失败轮次
未执行，不能记为通过。最终新 head 的证据以 PR 的绑定 SHA 自审评论为准。

## 对原始强制目标的差距

| 目标 | 实际状态 / 尚缺门槛 |
|---|---|
| A 旧源码保护 | 已有固定 tag、233 文件清单、哈希门禁和恢复记录；仍待完整切换后才可归档路径。 |
| B 自主前端/BFF | 独立实现与 app-only build 已有 CI 证据；不是默认生产前端。 |
| C 旧功能完整迁移 | 注册映射不等于行为对照。Live TV inert；深度 unavailable；Quote/期权/研究多项直接 UI 和真实 Provider 验收缺失。旧模拟 Paper 不能迁成真实账户或执行能力。 |
| Workspace | 已有多工作区/Tab、布局、CAS、导入导出与恢复；不能据此宣称完整时间范围/周期联动、任意插件隔离或团队权限管理。 |
| 专业图表 | 已有 Core/diagnostic/Yahoo 分离、指标、分页和导出；完整跨图同步、绘图、成交量分布、持仓订单标记、自定义指标扩展及逐笔回放未全部交付/验收。 |
| D OpenBB 融合 | 已实现若干原生研究适配与保存查询；财报/估值/收益率曲线、通用 Provider 管理、Pivot/Excel 等差距见能力矩阵。 |
| 数据真实性 | public CI 仅合成验收。真实 Futu/SIP/OPRA、历史覆盖和研究源授权需单独受控证据。不能把 unknown 提升为已验证。 |
| 安全与身份 | OIDC、角色、CSRF、服务 signer、所有权和禁用交易有实现/测试；仍需生产 issuer/ingress 部署和故障恢复验证。 |
| 用户资产迁移 | 禁止自动认领旧 SQLite；显式旧布局导入不等于完整旧账户/研究数据迁移。持久备份恢复及部署回滚未全部验收。 |
| 性能/容量 | 缺同一环境旧新成对性能、真实持续刷新及负载预算证明；不能拿合成页面时长代替。 |
| E/F 默认切换/解耦 | 原生候选可单独构建，但默认仍旧终端。全量验收前不能改默认 Compose 或提前移走唯一已接受终端。 |
| 许可与交付 | 运行时许可仍阻断。存在 Epic #60 / 子任务 #63 / PR #64，无须创建竞争 PR 或重复 Epic。 |

## 验证、合并与回滚

所有开源 build、容器、Next、浏览器和最终测试只由精确 PR HEAD 的 GitHub
Actions 执行。本地仅编辑、源码审查、读取 GitHub 元数据/已有产物和 Git
差异检查；没有运行本地 build、dev、Docker 或浏览器验收。

补丁使用同一个独立 worktree `EqoBoard-pr64-review`，任务分支
`codex/pr64-review-completion-20261016`；更新现有 PR #64 的 head 分支，
保留单一交付链。新 head 必须重新验证，旧成功不能继承。

目前不满足完整需求及 PR 自述的 release 门槛，因此不批准/合并、不切换
默认部署。不得清理尚待修复和验证的 worktree。回滚本次增量可逐个 revert
本次任务提交；旧源码、旧默认 Compose、旧数据及 execution=disabled 保留。
没有修改组织 ruleset、跳过失败检查或启用 Paper/Live。
