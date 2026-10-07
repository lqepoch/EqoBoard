# OpenBB Bridge Agent

路径：integrations/openbb/** 和 Rust Gateway 的 openbb_* endpoints。按官方 Custom Backend JSON 规范扩展，不复制 OpenBB 大型前端。
静态 widgets.json/apps.json 的 endpoint 必须与实际 Rust GET 路由匹配；全部 read-only；不能展示虚构 OI/GEX；无实时权限时 403 明确可见。
所有数据路径要求 token 鉴权、严格 Origin + TLS、单账户行情版权合规。参考 .agents/skills/openbb-workspace-bridge/SKILL.md。
上游版本是 2026-10-01 归档的 Apache-2.0 项目；OpenBB NOTICE 的专有 TradingView 高级图表禁用。