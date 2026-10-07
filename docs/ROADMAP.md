# EqoBoard Roadmap（按验收而非展示划分）

## 本次 Foundation
- [x] Rust crates + React Web 领域模块
- [x] Alpaca 股票 SIP 与期权 OPRA 快照、WS
- [x] 期权链（双侧报价，Greeks/IV）、K 线、IV Skew、逐笔成交
- [x] 多券商 Rust HTTP 适配契约 + 禁用/ Paper 门闩 + 一次性 Preview
- [x] Agent/Skills、CI 无凭据验证、只读外部 smoke、Docker
- [ ] 按 GitHub Actions 实际日志关闭编译/运行问题
- [ ] 标准化 Cargo.lock 与 package-lock.json 并冻结 supply chain

## 下一步 Paper MVP
- [ ] 股票/期权订单全生命周期，改单/撤单、服务端幂等、异步 fills
- [ ] Alpaca/IBKR/Schwab 单独执行服务、原子垂直价差真实 Paper 集成
- [ ] 账户/组合持仓与现金、盈亏分解、对账、执行追踪/链路延迟
- [ ] OAuth/OIDC、RBAC、动态股票订阅和多浏览器订阅租约持久化
- [ ] OHLCV 长期行情与 IV Surface、Skew/Term Structure、可追踪来源的 OI/GEX/Dealer Gamma
- [ ] 稳定量化策略指标计算：Vol/OI 异常、流动性价差、BBO 时效、保证金估算
- [ ] 数据质量/覆盖率审计、异常/断连告警

## 生产与企业演进
- [ ] 多用户权限、市场数据分发许可审查、审计保留合规
- [ ] Redis/PostgreSQL/Timescale（根据吞吐需求评估）、可恢复行情日志和订单状态机
- [ ] 不同设备 WebAuthn / OIDC + TLS / WAF
- [ ] OpenTelemetry、SLO、容量与高频背压压测、故障演练
- [ ] 部署蓝绿/灰度、回滚、备份、成本观测、版本化 API
