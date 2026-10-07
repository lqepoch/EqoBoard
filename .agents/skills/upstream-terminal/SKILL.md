---
name: upstream-terminal
description: 同步和扩展 EqoBoard 固定版本的原生 OpenTerminal Workspace、widgets、charts 与 research providers，控制下游差异。
---
# OpenTerminal Upstream Skill

1. 读取 `third_party/upstreams.lock.json` 的固定 SHA 与 MIT LICENSE。
2. 通用 Workspace、Command Palette、Chart、Watchlist、Screener、研究 Provider 优先同步上游；避免构建第二套前端。
3. EqoBoard 差异集中在 `web/lib/eqo-market.ts`、`web/app/api/eqo`、AG Grid Option Chain、IV Skew、OPRA Tape、Vertical Spread。
4. 核心股票/期权数据只能经 Rust Gateway；第三方研究 Provider 不参与核心行情回退。
5. 上游升级必须运行：server build/tests、web TypeScript、Next build、Rust CI、许可证/lock diff。
6. AG Grid Community 与 Lightweight Charts 等依赖按 lockfile 固定，版本升级通过单独 PR。
