---
name: option-chain-ui
description: 实现高频、可信、可操作的期权链 AG Grid 双边报价表，以及垂直价差预览与只读 Greek 展示。
---
# Option Chain UI Skill

路径：apps/web/src/components/OptionChain.tsx、VerticalBuilder.tsx、state.ts、types.ts。
优先 AG Grid Community 的 row ID=strike、applyTransactionAsync 批量更新；不要对每个 Quote 都 React setState 整表。
必须显示 call/put 双侧、strike、Bid/Ask、IV/Delta、as_of、数据源、授权错误和分页截断。
禁止假设两腿中间价可成交；不得把零 IV 或 null 转成数值 0。
交易：selected legs → 显式限价/debit/credit → Rust 风险预览 → 二次确认 → paper 门闩 → 交易 service；测试重复 submit 和失效 preview。
