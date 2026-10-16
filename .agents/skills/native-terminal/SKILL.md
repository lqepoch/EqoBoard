---
name: native-terminal
description: 维护 EqoBoard 独立原生终端、Workspace、Widget SDK 与模式隔离的 Next BFF。
---
# EqoBoard 原生终端

先阅读根目录与 apps/eqoboard-web/AGENTS.md、docs/migration 清单及当前冻结版本。新开发属于 apps/eqoboard-web；旧终端完整保留且默认只读，不复制其运行时作为依赖。复用具体第三方实现时保留固定源版本、原路径、许可证与 NOTICE，不将改编代码标为原创。

Widget通过静态 registry、配置schema和声明的读/动作allowlist接入。只使用共享行情host；所有浏览器请求经同源BFF，源事件保持现行Core契约、精确值、时间、generation/epoch/watermark与unknown/partial状态。原生图表的float只是投影，Core/diagnostic/Yahoo序列不得混为同一权威序列。

身份来自受信OIDC。Terminal与Research的hostname、cookie、签名密钥与issuer/audience/scope隔离；Yahoo仅Research，Engine仅Terminal。Paper/Live execution保持disabled，AI和研究数据不获得执行权限。持久数据独立目录，issuer+subject仅服务端定归属；无自动认领旧布局/账户数据。

OIDC 必须显式设置 `NEXTAUTH_URL`，且与精确 `EQO_PUBLIC_ORIGIN` 字符串相同，不带路径、凭据、query 或 fragment；缺失/错配应不可用，不能依赖请求 Host/forwarded host 推导回调基准。

修改哪个模块就补对应单元、契约和真实浏览器/容器测试。公共项目构建测试只在精确head GitHub Actions执行，不本地build、dev、Docker或真实Provider探测。不得用synthetic测试冒称Provider/生产验收。更新功能矩阵与真实状态，完整对照、身份迁移、同环境成对性能和回滚未通过时保留旧默认部署。
