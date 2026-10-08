---
name: openterminal-upstream
description: 在 EqoBoard 中同步和扩展 OpenTerminal，优先复用原生 Workspace、Widget、Chart、Provider，控制 fork 差异。
---
# OpenTerminal Upstream Skill

1. 读取 `docs/THIRD_PARTY.md` 的 pinned SHA。
2. 在仓库根运行 `python3 tools/upstream_diff.py`，用已锁定的 Git SHA 获取并验证上游树，逐文件审查 exact、modified、EqoBoard-only 和 deleted 清单；CI 将报告写入 Step Summary。未登记差异必须补充审计说明后再升级。
3. 通用功能同步上游；EqoBoard 差异保持在数据适配、AG Grid Option Chain、IV/OPRA/Vertical 等少数文件。
4. 不恢复被删除的平行 Vite 终端。
5. OpenBB Research 只作为可选原生 Sidebar/Command Palette 外链；读取服务端验证的 `EQO_RESEARCH_PUBLIC_ORIGIN`，新标签使用 `noopener noreferrer`。不得嵌入 Vite UI、iframe 或把该入口描述为已集成 OpenBB OIDC/Gateway 委托认证。
6. 执行 OpenTerminal server build/test、web typecheck/build。
7. 更新 pinned SHA 和许可证记录后再提交。
8. 新研究视图必须注册在现有 Workspace/Sidebar/widget registry，复用原生 Chart/Widget；注册预测只能走同源短时授权 BFF，显示公开投影和未知证据状态，不得读取 private envelope 或因预测视图引入第二套终端。
