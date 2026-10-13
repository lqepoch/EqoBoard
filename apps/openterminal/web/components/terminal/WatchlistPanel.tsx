"use client";

import React, { useState } from "react";
import { useTradingStore, type WatchlistGroup } from "../../store/trading-terminal";

// 辅助生成 mini sparkline 曲线
function renderMiniSparkline(isUp: boolean, seed: number) {
  const points = isUp
    ? [
        [0, 14],
        [8, 12],
        [16, 15],
        [24, 9],
        [32, 11],
        [40, 6],
        [48, 8],
        [56, 3],
      ]
    : [
        [0, 4],
        [8, 6],
        [16, 3],
        [24, 10],
        [32, 8],
        [40, 13],
        [48, 11],
        [56, 15],
      ];

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  const strokeColor = isUp ? "#10b981" : "#f43f5e";

  return (
    <svg width="56" height="18" className="overflow-visible opacity-90">
      <path
        d={pathD}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function WatchlistPanel() {
  const {
    activeSymbol,
    setActiveSymbol,
    watchlist,
    activeGroup,
    setActiveGroup,
    watchlistQuotes,
  } = useTradingStore();

  const [filterText, setFilterText] = useState("");

  const filteredSymbols = watchlist.filter((sym) =>
    sym.toLowerCase().includes(filterText.toLowerCase())
  );

  return (
    <aside className="w-80 bg-[#0a0d14] border-r border-[#1a2233] flex flex-col h-full select-none shrink-0 overflow-hidden">
      {/* 顶部 Segmented 分类 Tabs */}
      <div className="pt-2 px-2 bg-[#0a0d14] border-b border-[#141b28]">
        <div className="flex items-center justify-between gap-1 pb-1.5 border-b border-[#141b28]">
          {(["ALL", "MAG7", "TECH", "ETF", "SEMI"] as WatchlistGroup[]).map((group) => (
            <button
              key={group}
              onClick={() => setActiveGroup(group)}
              className={`flex-1 py-1 text-[10px] font-mono tracking-wider font-semibold transition-all relative ${
                activeGroup === group
                  ? "text-cyan-300 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              [{group}]
              {activeGroup === group && (
                <span className="absolute bottom-0 left-1 right-1 h-0.5 bg-cyan-400 shadow-sm shadow-cyan-400" />
              )}
            </button>
          ))}
        </div>

        {/* 快速搜索框 */}
        <div className="py-2">
          <div className="relative flex items-center">
            <span className="absolute left-2.5 text-slate-500 text-[10px]">🔍</span>
            <input
              type="text"
              placeholder="Search ticker..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="w-full bg-[#101520] border border-[#1a2436] text-slate-100 placeholder-slate-500 text-[10px] pl-7 pr-3 py-1 rounded focus:outline-none focus:border-cyan-500 font-mono transition-colors"
            />
          </div>
        </div>
      </div>

      {/* 自选列表表头 */}
      <div className="grid grid-cols-12 px-3 py-1.5 bg-[#0d121c] border-b border-[#182133] text-[9px] font-mono text-slate-400 uppercase tracking-wider">
        <span className="col-span-4">SYMBOL</span>
        <span className="col-span-3 text-right">LAST</span>
        <span className="col-span-3 text-right">CHG%</span>
        <span className="col-span-2 text-right">VOL</span>
      </div>

      {/* 自选股主数据列表 */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#121824] scrollbar-thin">
        {filteredSymbols.map((sym, idx) => {
          const quote = watchlistQuotes[sym];
          const isSelected = activeSymbol === sym;
          const isUp = (quote?.changePercent ?? 0) >= 0;
          const price = quote?.price ? quote.price.toFixed(2) : "---";
          const changePercent =
            quote?.changePercent !== undefined
              ? `${isUp ? "+" : ""}${quote.changePercent.toFixed(2)}%`
              : "---";

          const volumeStr = quote?.volume
            ? quote.volume > 1_000_000
              ? `${(quote.volume / 1_000_000).toFixed(2)}M`
              : `${(quote.volume / 1_000).toFixed(1)}K`
            : "---";

          return (
            <div
              key={sym}
              onClick={() => setActiveSymbol(sym)}
              className={`group grid grid-cols-12 items-center px-3 py-2 cursor-pointer transition-colors relative ${
                isSelected
                  ? "bg-[#111928] border-l-2 border-cyan-400"
                  : "hover:bg-[#0f1420] border-l-2 border-transparent"
              }`}
            >
              {/* Symbol & Star */}
              <div className="col-span-4 flex items-center gap-1.5 min-w-0">
                <span
                  className={`text-[10px] transition-colors ${
                    isSelected ? "text-cyan-400 font-bold" : "text-slate-600 group-hover:text-slate-400"
                  }`}
                >
                  ★
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="font-mono font-bold text-slate-100 text-[11px] tracking-wide">
                    {sym}
                  </span>
                  <span className="text-[9px] font-mono text-slate-500 tabular-nums">
                    ${price}
                  </span>
                </div>
              </div>

              {/* Price */}
              <div className="col-span-3 text-right">
                <span className="font-mono text-[11px] tabular-nums font-semibold text-slate-100">
                  ${price}
                </span>
              </div>

              {/* Change % Badge */}
              <div className="col-span-3 text-right flex items-center justify-end">
                <span
                  className={`font-mono text-[9px] tabular-nums font-bold px-1.5 py-0.5 rounded border ${
                    quote?.changePercent === undefined
                      ? "text-slate-400 bg-slate-800 border-slate-700"
                      : isUp
                      ? "text-emerald-300 bg-emerald-950/70 border-emerald-700/60"
                      : "text-rose-300 bg-rose-950/70 border-rose-700/60"
                  }`}
                >
                  {changePercent}
                </span>
              </div>

              {/* Volume */}
              <div className="col-span-2 text-right">
                <span className="font-mono text-[9px] tabular-nums text-slate-400">
                  {volumeStr}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部卡片: Sector Heatmap mini */}
      <div className="h-28 bg-[#0b0e16] border-t border-[#1a2233] p-2.5 flex flex-col justify-between shrink-0">
        <div className="flex items-center justify-between text-[10px] font-mono">
          <span className="text-slate-400 font-medium">Sector Heatmap mini</span>
          <span className="text-slate-600 text-xs">⋯</span>
        </div>

        {/* 3 个板块热度色块 */}
        <div className="grid grid-cols-3 gap-1.5 h-16">
          {/* Tech */}
          <div className="rounded bg-gradient-to-br from-emerald-900/60 to-emerald-950/90 border border-emerald-700/50 p-1.5 flex flex-col justify-center items-center text-center">
            <span className="text-[10px] font-sans font-medium text-slate-200">Tech</span>
            <span className="text-[11px] font-mono font-bold text-emerald-300 tabular-nums">
              +0.8%
            </span>
          </div>

          {/* Energy */}
          <div className="rounded bg-gradient-to-br from-rose-900/60 to-rose-950/90 border border-rose-700/50 p-1.5 flex flex-col justify-center items-center text-center">
            <span className="text-[10px] font-sans font-medium text-slate-200">Energy</span>
            <span className="text-[11px] font-mono font-bold text-rose-300 tabular-nums">
              -1.2%
            </span>
          </div>

          {/* Health */}
          <div className="rounded bg-gradient-to-br from-teal-900/40 to-slate-900/80 border border-teal-700/40 p-1.5 flex flex-col justify-center items-center text-center">
            <span className="text-[10px] font-sans font-medium text-slate-200">Health</span>
            <span className="text-[11px] font-mono font-bold text-teal-300 tabular-nums">
              +0.3%
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
