# OpenTerminal integration Agent

该目录源于 OpenTerminal MIT 上游。通用功能优先保留上游实现。

- 上游基线见 `docs/THIRD_PARTY.md`。
- 股票/期权价格、K线、Option Chain 只能通过 `web/lib/eqo-market.ts` → Rust Gateway。
- FRED/SEC/FINRA/新闻等补充研究 Provider 可沿用上游 server。
- EqoBoard 自有 widget 放在 `web/components/widgets`，优先复用当前依赖，避免再引入同类 UI 框架。
- Option Chain 固定 AG Grid Community；空 IV/Greeks 不转换成 0。
- 新交易 UI 只能调用服务端 `/api/eqo/orders/*`，浏览器不得接触券商/Alpaca密钥。
- 同步上游必须保留 MIT LICENSE、固定 commit、diff 记录并运行全部构建。
