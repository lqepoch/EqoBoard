"use client";

import React, { useState, useEffect } from "react";
import { useTradingStore } from "../../store/trading-terminal";

export default function PaperTradingPanel({
  selectedPrice,
}: {
  selectedPrice?: number | null;
}) {
  const {
    activeSymbol,
    currentQuote,
    paperAccount,
    placeOrder,
  } = useTradingStore();

  const [orderSide, setOrderSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("LIMIT");
  const [priceInput, setPriceInput] = useState<string>("");
  const [sharesInput, setSharesInput] = useState<string>("100");
  const [lowerTab, setLowerTab] = useState<"POSITIONS" | "HISTORY">("POSITIONS");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // 当外部点击盘口价格时自动更新限价输入
  useEffect(() => {
    if (selectedPrice) {
      setPriceInput(selectedPrice.toFixed(2));
    } else if (currentQuote?.price) {
      setPriceInput(currentQuote.price.toFixed(2));
    }
  }, [selectedPrice, currentQuote?.price, activeSymbol]);

  const numShares = parseInt(sharesInput, 10) || 0;
  const unitPrice =
    orderType === "MARKET"
      ? currentQuote?.price || 740.74
      : parseFloat(priceInput) || currentQuote?.price || 740.74;
  const estimatedTotal = Number((numShares * unitPrice).toFixed(2));

  const handlePercentageSize = (pct: number) => {
    if (orderSide === "BUY") {
      if (unitPrice > 0) {
        const totalAffordable = Math.floor(paperAccount.cash / unitPrice);
        const count = Math.max(1, Math.floor(totalAffordable * (pct / 100)));
        setSharesInput(String(count));
      }
    } else {
      const pos = paperAccount.positions.find((p) => p.symbol === activeSymbol);
      if (pos) {
        const count = Math.max(1, Math.floor(pos.shares * (pct / 100)));
        setSharesInput(String(count));
      } else {
        setSharesInput("10");
      }
    }
  };

  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (numShares <= 0 || unitPrice <= 0) return;

    setIsSubmitting(true);
    setFeedback(null);

    const success = await placeOrder({
      symbol: activeSymbol,
      side: orderSide,
      type: orderType,
      shares: numShares,
      price: unitPrice,
    });

    setIsSubmitting(false);
    if (success) {
      setFeedback(`FILLED: ${orderSide} ${numShares} ${activeSymbol} @ $${unitPrice.toFixed(2)}`);
      setTimeout(() => setFeedback(null), 3000);
    } else {
      setFeedback("Order rejected: check balance/shares");
      setTimeout(() => setFeedback(null), 3000);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] select-none overflow-hidden">
      {/* 头部标题 */}
      <div className="h-8 bg-[#0b0e16] border-b border-[#141b28] px-3 flex items-center justify-between shrink-0">
        <span className="text-[10px] font-mono font-semibold text-slate-300">
          Institutional Execution Ticket
        </span>
        <span className="text-slate-600 text-xs">⋯</span>
      </div>

      {/* 票据操作区 */}
      <form onSubmit={handleSubmitOrder} className="p-2.5 flex flex-col gap-2 shrink-0">
        {/* 买卖方向大按钮 */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setOrderSide("BUY")}
            className={`py-1.5 text-xs font-mono font-bold rounded transition-all ${
              orderSide === "BUY"
                ? "bg-[#10b981] text-black shadow-xs shadow-emerald-500/30"
                : "bg-[#121722] text-slate-400 hover:text-slate-200 border border-[#1a2436]"
            }`}
          >
            BUY / LONG
          </button>
          <button
            type="button"
            onClick={() => setOrderSide("SELL")}
            className={`py-1.5 text-xs font-mono font-bold rounded transition-all ${
              orderSide === "SELL"
                ? "bg-[#f43f5e] text-white shadow-xs shadow-rose-500/30"
                : "bg-[#121722] text-slate-400 hover:text-slate-200 border border-[#1a2436]"
            }`}
          >
            SELL / SHORT
          </button>
        </div>

        {/* 订单类型选择 */}
        <div className="flex items-center justify-between bg-[#101520] border border-[#1a2436] rounded px-2 py-1 text-[10px] font-mono text-slate-300">
          <span>LIMIT / MARKET</span>
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as "MARKET" | "LIMIT")}
            className="bg-transparent text-slate-200 focus:outline-none cursor-pointer"
          >
            <option value="LIMIT">LIMIT</option>
            <option value="MARKET">MARKET</option>
          </select>
        </div>

        {/* 限价输入 & 数量输入 */}
        <div className="grid grid-cols-2 gap-2">
          {/* Price */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-mono text-slate-500">Price</span>
            <input
              type="number"
              step="0.01"
              value={priceInput}
              disabled={orderType === "MARKET"}
              onChange={(e) => setPriceInput(e.target.value)}
              className="w-full bg-[#101520] border border-[#1a2436] text-slate-100 text-[11px] px-2 py-1 rounded focus:outline-none focus:border-cyan-500 font-mono font-bold tabular-nums"
              placeholder="$0.00"
            />
          </div>

          {/* Quantity */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-mono text-slate-500">Quantity (Shares)</span>
            <input
              type="number"
              min="1"
              value={sharesInput}
              onChange={(e) => setSharesInput(e.target.value)}
              className="w-full bg-[#101520] border border-[#1a2436] text-slate-100 text-[11px] px-2 py-1 rounded focus:outline-none focus:border-cyan-500 font-mono font-bold tabular-nums"
            />
          </div>
        </div>

        {/* 快捷仓位比例按钮: 25%, 50%, 75%, MAX */}
        <div className="grid grid-cols-4 gap-1">
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => handlePercentageSize(pct)}
              className="py-0.5 text-[9px] font-mono rounded bg-[#121722] hover:bg-[#182030] text-slate-400 hover:text-slate-200 border border-[#1a2436] transition-colors"
            >
              {pct === 100 ? "MAX" : `${pct}%`}
            </button>
          ))}
        </div>

        {/* Total 计算 */}
        <div className="flex items-center justify-between px-1 py-0.5 text-[10px] font-mono">
          <span className="text-slate-400">Total</span>
          <span className="text-slate-100 font-bold tabular-nums text-xs">
            ${estimatedTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        {/* 提交纸盘订单 CTA 大按钮 */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full py-2 rounded bg-gradient-to-r from-cyan-400 to-teal-400 hover:from-cyan-300 hover:to-teal-300 text-black font-mono font-bold text-xs tracking-wider transition-all shadow-md shadow-cyan-500/20 active:scale-[0.99]"
        >
          {isSubmitting ? "TRANSMITTING..." : "TRANSMIT PAPER ORDER"}
        </button>

        {feedback && (
          <div className="text-[9px] font-mono text-cyan-300 text-center bg-cyan-950/50 py-0.5 rounded border border-cyan-800/40">
            {feedback}
          </div>
        )}
      </form>

      {/* 下半部分: Open Positions & Fill History 表格 */}
      <div className="flex-1 flex flex-col min-h-0 border-t border-[#141b28]">
        {/* 选项卡 */}
        <div className="h-6 bg-[#0b0e16] border-b border-[#141b28] px-2 flex items-center justify-between text-[9px] font-mono shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLowerTab("POSITIONS")}
              className={`font-semibold transition-colors ${
                lowerTab === "POSITIONS" ? "text-cyan-300 font-bold" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              Open Positions
            </button>
            <button
              onClick={() => setLowerTab("HISTORY")}
              className={`font-semibold transition-colors ${
                lowerTab === "HISTORY" ? "text-cyan-300 font-bold" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              Fill History
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-slate-500">
            <span>+</span>
            <span>≡</span>
          </div>
        </div>

        {/* 表头 */}
        <div className="grid grid-cols-12 px-2.5 py-1 bg-[#0d121c] text-[8px] font-mono text-slate-500 uppercase tracking-wider border-b border-[#141b28]">
          <span className="col-span-4">Symbol</span>
          <span className="col-span-4 text-right">Unrealized P&L</span>
          <span className="col-span-4 text-right">Fill Hilt</span>
        </div>

        {/* 表格数据 */}
        <div className="flex-1 overflow-y-auto divide-y divide-[#121824] text-[9px] font-mono">
          {lowerTab === "POSITIONS" ? (
            paperAccount.positions.map((pos) => {
              const isProfit = pos.unrealizedPL >= 0;
              return (
                <div key={pos.symbol} className="grid grid-cols-12 px-2.5 py-1.5 items-center hover:bg-[#101520]">
                  <span className="col-span-4 font-bold text-slate-200">{pos.symbol}</span>
                  <span
                    className={`col-span-4 text-right font-semibold tabular-nums ${
                      isProfit ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {isProfit ? "+" : ""}{pos.unrealizedPL.toFixed(2)}
                  </span>
                  <span className="col-span-4 text-right text-slate-400 tabular-nums">
                    {pos.shares}
                  </span>
                </div>
              );
            })
          ) : (
            paperAccount.orders.map((ord) => (
              <div key={ord.id} className="grid grid-cols-12 px-2.5 py-1.5 items-center hover:bg-[#101520]">
                <span className="col-span-4 font-bold text-slate-200">{ord.symbol}</span>
                <span className="col-span-4 text-right text-slate-400 tabular-nums">
                  ${ord.price.toFixed(2)}
                </span>
                <span className="col-span-4 text-right text-emerald-400 font-semibold">
                  {ord.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
