---
name: upstream-terminal
description: 维护 EqoBoard 引入的 MIT OpenTerminal Widget Store、拖拽 Workspace、Ticker 联动和命令面板，避免重造前端组件。
---
# OpenTerminal 复用 Skill

1. 核对 third_party/upstreams.lock.json：指定上游 ErTasselli/OpenTerminal commit 与 MIT LICENSE，适配文件保留来源和改造声明。
2. 同步前对比上游 web/store/terminal.ts、web/components/Workspace.tsx、web/components/CommandPalette.tsx；改造适应 react-grid-layout v2，尽量保留上游语义和单一 widget registry。
3. Widget 添加/删除/布局保存/恢复/linked/unlinked/个股锁定/快捷键都由 OpenTerminal 移植层管理，页面组件独立渲染，不复制第二套 store。
4. 浏览器任何 Widget 禁用第三方免费行情 URL；数据只能使用 Alpaca via Rust，失败时显示来源/时间戳/错误。
5. TypeScript typecheck + Vitest + Vite build + RGL drag/persist/unlink UI 测试是验收门槛。
6. 期权链复用 AG Grid Community，股票图复用 Lightweight Charts，BrokerAdapter 不写入 upstream UI。