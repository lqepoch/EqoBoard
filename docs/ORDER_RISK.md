# 订单风险计算边界（#2-A）

`validate_order_at` 是 Paper preview 风险检查的纯计算入口；`validate_order` 以当前 UTC 日期调用它。校验和风险都在服务端执行，客户端的 `net_effect` 不能决定方向或覆盖风险计算。本轮没有实现持久订单账本、账户 buying power 或券商成交确认；Paper submit 仍须由 Gateway 关闭。

## 合约范围

- 股票按整数股处理，价格只接受精确美分输入。
- 期权仅支持格式有效、标准 ASCII 字母 OCC root 的美股/ETF 单腿买入和两腿垂直价差。金额计算固定采用每张 100 股的标准 multiplier。
- 含数字的 adjusted root、无效 OCC、非 100 multiplier 或非标准 deliverable 必须拒绝。当前 OrderIntent 没有可信合约主数据，字母 root 本身不能证明实际 deliverable 为 100；adapter 在任何真实 Paper 能力开放前仍必须从券商/合约目录核实乘数和 deliverable。不能把本地模拟能力描述为真实 Paper。
- 合约到期日必须严格晚于校验日期；今日到期和已过期合约一律拒绝，避免时区、收盘和行权处理未实现时产生风险低估。
- `quantity` 必须在 `1..=EQO_MAX_ORDER_QTY` 范围。执行层接受的 option limit precision 为整美分；低于美分或更高精度输入拒绝。此精度规则不是交易所 tick table：每个系列的 penny/nickel tick 必须由后续具备合约元数据的 adapter 校验，本轮不会臆测。

OCC 说明标准股票期权每张通常代表 100 股，但公司行动可以产生非标准 deliverable 或乘数，因此固定 100 只适用于上述受限范围：[OCC Equity Options product specifications](https://www.theocc.com/clearance-and-settlement/clearing/equity-options-product-specifications)、[OCC OSI adjusted-root rule](https://infomemo.theocc.com/infomemos?number=26853)。OCC说明数字后缀用于识别非标准 adjusted symbol；如果调整后的合约仍与标准合约相同，符号不变。执行器当前拒绝含数字的 root，并只计算 100 multiplier，但没有合约目录时仍不能证明任意字母 root 的实际 deliverable；这是 Paper adapter 打开前必须补的服务端检查。

## 整数精度与风险公式

OCC 符号尾部 8 位按千分之一美元解析为整数 `strike_millis`；不使用领域层 `f64 strike` 做方向或宽度比较。v1 请求仍用兼容性的 JSON 数值 `limit_price`，执行层基于该数值最短往返十进制表示做严格定点转换，只接受精确整美分，并拒绝精度已不足以区分美分/千分美元的极大数。风险计算转换成千分之一美元整数并全程使用 checked multiplication/addition；非有限价格、精度不符、溢出或非正风险上限均失败关闭。返回的 `estimated_max_loss` 在转成 USD JSON number 后还必须能往返到同一整数千分美元数。

- 股票买单：`limit_cents × quantity` 美分。
- 买入单腿期权：`limit_cents × 100 × quantity` 美分；单腿卖出拒绝。
- Call：买入低执行价、卖出高执行价推导为 Debit；买入高执行价、卖出低执行价推导为 Credit。
- Put：买入高执行价、卖出低执行价推导为 Debit；买入低执行价、卖出高执行价推导为 Credit。
- Vertical 必须恰有一买一卖、同 underlying/到期日/权利类型、不同执行价，且净价严格小于执行价宽度。与上述方向推导冲突的 `net_effect` 拒绝。
- Debit vertical 最大毛损：净借记限价 × 100 × quantity。Credit vertical 最大毛损：(执行价宽度 − 净贷记限价) × 100 × quantity。两者按 strike 的千分美元整数及 limit 美分换算后计算。

风险金额是到期 payoff 的**毛损**，不含券商佣金、交易所/监管费用、行权/指派费用或后续平仓费用；v1 没有可验证的统一 fee schedule，因此不能将该数值称为 all-in 最大损失。Paper/live 委托能力仍保持关闭，直到账户级风险和费用政策接入。

Gateway 的当前 preview 进程内保存 60 秒，消费前按受信身份 `(idp_iss, sub)` 验证所有权；OIDC subject 只在 issuer 内唯一，所以不同 issuer 下相同 subject 不能共享 preview。该短时存储只支持本轮离线预览/确认一致性，不代表持久订单账本。Gateway 对所有券商的 Paper/Live capability 显示 disabled，adapter endpoint 已配置也不等于真实券商能力。submit 被阻止时不消费 preview、不调用 adapter；若未来请求已进入 adapter 后结果不确定，必须返回 `UNKNOWN`、保留原 `client_order_id` 和恢复关联，禁止建议用户换 ID 重下。

## Issue #2-A 反例

输入买入 `QQQ261009P00600000` 并卖出 `QQQ261009P00620000`，quantity=1、limit_price=0.01、net_effect=debit：低执行价多头 put / 高执行价空头 put 与 debit 方向矛盾，preview 拒绝。若声明正确推导的 credit，最大毛损为 `(20.00 - 0.01) × 100 = $1,999`，超过默认 `$1,000` 风险上限而拒绝。该反例用 `validate_order_at` 的固定校验日期测试，结果不依赖测试运行当天。

## 验收

执行 `cargo test -p eqo-execution` 与 `cargo clippy -p eqo-execution --all-targets -- -D warnings`。用例覆盖 Call/Put × Debit/Credit × 两种 legs 数组顺序、相反方向冲突、整数最大毛损、expiry边界、adjusted root、sub-cent、spread width、数量、跨 underlying/right/expiry、live 拒绝和一次性 preview。测试只用本地数据，不调用券商服务。
