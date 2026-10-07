---
name: openterminal-upstream
description: 在 EqoBoard 中同步和扩展 OpenTerminal，优先复用原生 Workspace、Widget、Chart、Provider，控制 fork 差异。
---
# OpenTerminal Upstream Skill

1. 读取 `docs/THIRD_PARTY.md` 的 pinned SHA。
2. 比较上游新 SHA 与当前基线，按 Workspace、widgets、server providers、security 分组审查。
3. 通用功能同步上游；EqoBoard 差异保持在数据适配、AG Grid Option Chain、IV/OPRA/Vertical 等少数文件。
4. 不恢复被删除的平行 Vite 终端。
5. 执行 OpenTerminal server build/test、web typecheck/build。
6. 更新 pinned SHA 和许可证记录后再提交。
