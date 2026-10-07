---
name: option-chain-ui
description: 实现高频、可信、可操作的期权链 AG Grid 双边报价表，以及垂直价差预览与只读 Greek 展示。
---
# Option Chain UI Skill

路径：`apps/openterminal/web/components/widgets/OptionsWidget.tsx`、`IvSkewWidget.tsx`、
`OptionTapeWidget.tsx`、`VerticalSpreadWidget.tsx` 与 `web/store/market.ts`。
优先 AG Grid Community 的 row ID=strike、applyTransactionAsync 批量更新；不要对每个 Quote 都 React setState 整表。
必须显示 call/put 双侧、strike、Bid/Ask、IV/Delta、数据源、授权/ACK/覆盖/新鲜度错误和分页截断。
OPRA 只标注 quote/trade feed。IV/Greeks 属 Alpaca REST option snapshot vendor/model 字段，不是 OPRA 原生字段；缺少独立模型时间时显示 `model as-of unknown`，不能借用 quote/trade event time 或 Gateway response time。
期权订阅按稳定 OCC membership 续租。释放时用更高 generation 的空 membership tombstone，旧 renew/cleanup 不得复活或删除新租约。
Underlying ATM 只使用 Rust Gateway 返回的真实 SIP snapshot；SIP 不可用就显示 unavailable，不得用链中位 strike 或其他数据源伪造。
禁止假设两腿中间价可成交；不得把零 IV 或 null 转成数值 0。
交易仍为关闭状态：本版本只允许服务器风险预览；Paper submit 必须显示 blocked，Live 始终拒绝。预览以服务端返回并锁定的 intent、preview ID 与 expiry 为准；表单或腿变化递增 generation 并更新 fingerprint，使旧请求/旧预览失效，确认时再次核对锁定 intent 和 expiry。不得用本地 simulation 冒充券商 Paper。

若提交响应或连接结果为 UNKNOWN，保留原 client_order_id 与操作关联，显示需要恢复/对账，并禁止换新 ID 重下。只有服务端明确返回 rejected 或 blocked 才显示对应终态；超时、冲突或无回包不能推断为拒单。
