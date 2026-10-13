"use client";

import React, { useState } from "react";
import { useTradingStore } from "../../store/trading-terminal";

export default function OrderBookPanel({
  onSelectPrice,
}: {
  onSelectPrice?: (price: number) => void;
}) {
  const { orderBook, trades, activeSymbol } = useTradingStore();
  const [activeTab, setActiveTab] = useState<"BOOK" | "TRADES">("BOOK");

  const maxBidTotal = orderBook?.bids?.[orderBook.bids.length - 1]?.total || 1;
  const maxAskTotal = orderBook?.asks?.[0]?.total || 1;
  const maxTotal = Math.max(maxBidTotal, maxAskTotal);

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] border-b border-[#141b28] select-none overflow-hidden">
      {/* 头部切换 Tab */}
      <div className="h-8 bg-[#0b0e16] border-b border-[#141b28] flex items-center justify-between px-2.5 shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab("BOOK")}
            className={`px-2 py-0.5 text-[10px] font-mono rounded font-semibold transition-colors ${
              activeTab === "BOOK"
                ? "bg-cyan-950/80 text-cyan-300 font-bold border border-cyan-700/80"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Level 2 Book (10)
          </button>
          <button
            onClick={() => setActiveTab("TRADES")}
            className={`px-2 py-0.5 text-[10px] font-mono rounded font-semibold transition-colors ${
              activeTab === "TRADES"
                ? "bg-cyan-950/80 text-cyan-300 font-bold border border-cyan-700/80"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Time & Sales
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-400 font-bold bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-800/50">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            1s 极速
          </span>
          <span className="text-[10px] font-mono text-slate-300 font-bold">
            {activeSymbol}
          </span>
        </div>
      </div>

      {activeTab === "BOOK" ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* 表头: Ask 和 Bid 标识 */}
          <div className="grid grid-cols-12 px-2.5 py-1 bg-[#0d121c] text-[9px] font-mono text-slate-400 uppercase tracking-wider border-b border-[#141b28]">
            <span className="col-span-3">Ask</span>
            <span className="col-span-5 text-center">Depth Price</span>
            <span className="col-span-4 text-right">Bid</span>
          </div>

          {/* 卖单区域 (Ask 10 -> Ask 1 倒序) */}
          <div className="flex-1 overflow-hidden flex flex-col justify-end divide-y divide-[#121824]/50">
            {orderBook?.asks?.map((ask) => {
              const widthPct = Math.min(100, Math.round((ask.total / maxTotal) * 100));
              return (
                <div
                  key={`ask-${ask.level}`}
                  onClick={() => onSelectPrice?.(ask.price)}
                  className="group relative grid grid-cols-12 px-2.5 py-0.5 text-[10px] font-mono cursor-pointer hover:bg-rose-950/30"
                >
                  {/* 可视化深度填充条 (红) */}
                  <div
                    className="absolute right-0 top-0 bottom-0 bg-rose-500/15 pointer-events-none transition-all"
                    style={{ width: `${widthPct}%` }}
                  />
                  <span className="col-span-3 text-slate-500 text-[9px]">Ask {ask.level}</span>
                  <span className="col-span-5 text-center text-rose-400 font-bold tabular-nums">
                    ${ask.price.toFixed(2)}
                  </span>
                  <span className="col-span-4 text-right text-slate-300 tabular-nums">
                    {ask.size.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>

          {/* 中间 Spread 买卖价差分割条 */}
          <div className="h-6 bg-[#0e131e] border-y border-[#141b28] px-3 flex items-center justify-between text-[10px] font-mono shrink-0">
            <span className="text-slate-400">Spread:</span>
            <span className="text-amber-400 font-bold tabular-nums">
              ${orderBook?.spread?.toFixed(2) || "0.01"} ({orderBook?.spreadPercent?.toFixed(2) || "0.01"}%)
            </span>
          </div>

          {/* 买单区域 (Bid 1 -> Bid 10 正序) */}
          <div className="flex-1 overflow-hidden flex flex-col justify-start divide-y divide-[#121824]/50">
            {orderBook?.bids?.map((bid) => {
              const widthPct = Math.min(100, Math.round((bid.total / maxTotal) * 100));
              return (
                <div
                  key={`bid-${bid.level}`}
                  onClick={() => onSelectPrice?.(bid.price)}
                  className="group relative grid grid-cols-12 px-2.5 py-0.5 text-[10px] font-mono cursor-pointer hover:bg-emerald-950/30"
                >
                  {/* 可视化深度填充条 (绿) */}
                  <div
                    className="absolute right-0 top-0 bottom-0 bg-emerald-500/15 pointer-events-none transition-all"
                    style={{ width: `${widthPct}%` }}
                  />
                  <span className="col-span-3 text-slate-500 text-[9px]">Bid {bid.level}</span>
                  <span className="col-span-5 text-center text-emerald-400 font-bold tabular-nums">
                    ${bid.price.toFixed(2)}
                  </span>
                  <span className="col-span-4 text-right text-slate-300 tabular-nums">
                    {bid.size.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Time & Sales 逐笔流水 */}
          <div className="grid grid-cols-12 px-2.5 py-1 bg-[#0d121c] text-[9px] font-mono text-slate-400 uppercase tracking-wider border-b border-[#141b28]">
            <span className="col-span-5">Time</span>
            <span className="col-span-3 text-right">Price</span>
            <span className="col-span-2 text-right">Size</span>
            <span className="col-span-2 text-center">Tick</span>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-[#121824]/50">
            {trades.map((t) => (
              <div
                key={t.id}
                onClick={() => onSelectPrice?.(t.price)}
                className="grid grid-cols-12 px-2.5 py-0.5 items-center text-[10px] font-mono hover:bg-[#101520] cursor-pointer"
              >
                <span className="col-span-5 text-slate-500 text-[9px] tabular-nums truncate">
                  {t.time}
                </span>
                <span
                  className={`col-span-3 text-right font-bold tabular-nums ${
                    t.side === "BUY"
                      ? "text-emerald-400"
                      : t.side === "SELL"
                      ? "text-rose-400"
                      : "text-slate-300"
                  }`}
                >
                  ${t.price.toFixed(2)}
                </span>
                <span className="col-span-2 text-right text-slate-300 tabular-nums">
                  {t.size}
                </span>
                <span className="col-span-2 text-center flex items-center justify-center">
                  {t.side === "BUY" ? (
                    <span className="text-emerald-400 font-bold text-xs">↑</span>
                  ) : t.side === "SELL" ? (
                    <span className="text-rose-400 font-bold text-xs">↓</span>
                  ) : (
                    <span className="text-slate-500 font-bold text-xs">·</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
