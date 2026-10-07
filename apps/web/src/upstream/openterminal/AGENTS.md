# 上游 OpenTerminal 适配 Agent

路径：apps/web/src/upstream/openterminal/**。这些文件是 ErTasselli/OpenTerminal MIT 代码的衍生移植实现，严禁移除原版权信息。
修改前核对 third_party/upstreams.lock.json 锁定的 Commit、第三方许可证，遵循 .agents/skills/upstream-terminal/SKILL.md。
主 Workspace 只有一个 Widget registry 权威实现；有功能直接修改该移植代码。期权链沿用 AG Grid，股票 K 线沿用 Lightweight Charts。
行情必须通过 EqoBoard Rust 网关，不能恢复 OpenTerminal 的 Yahoo/Nasdaq 免费 fallback 链；跨券商下单仍通过 BrokerAdapter 风控，不可写浏览器 SDK。