## 目的 / 变更范围
<!-- 模块、目标功能、影响的 API/契约 -->

## 验证证据
- [ ] cargo fmt / clippy / test
- [ ] Web typecheck / test / build
- [ ] SIP/OPRA 来源和时间戳未被篡改
- [ ] 不含私钥/个人账户信息，PR CI 不读取 Secrets
- [ ] 交易写操作仍禁用或仅 Paper 且具备二次确认
- [ ] 断连、权限失败、重复委托和回滚验证

## 风险与回滚
<!-- 风险边界，回滚 SHA，数据迁移/合规影响 -->
