"use client";

import React, { useState, useEffect } from "react";
import { useTradingStore } from "../../store/trading-terminal";

export default function TerminalHeader() {
  const {
    activeSymbol,
    setActiveSymbol,
    currentQuote,
    futuStatus,
    paperAccount,
  } = useTradingStore();

  const [searchInput, setSearchInput] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"TRADE" | "WATCHLIST" | "OPTIONS" | "ANALYTICS">("TRADE");

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      setActiveSymbol(searchInput.trim().toUpperCase());
      setSearchInput("");
      setDropdownOpen(false);
    }
  };

  const isUp = (currentQuote?.change ?? 0) >= 0;

  // 标的名称回退
  const symbolName = currentQuote?.name || (activeSymbol === "QQQ" ? "Invesco QQQ Trust ETF" : `${activeSymbol} Equity`);
  const activePrice = currentQuote?.price ? currentQuote.price.toFixed(2) : "740.53";
  const activeChange = currentQuote?.change ? currentQuote.change.toFixed(2) : "-5.30";
  const activeChangePct = currentQuote?.changePercent ? currentQuote.changePercent.toFixed(2) : "-0.71";

  return (
    <header className="flex flex-col bg-[#07090e] border-b border-[#1a2233] select-none z-30 shrink-0">
      {/* =========================================================================
          Tier 1: Topmost System Navigation & Command Omnibox (Height ~36px)
         ========================================================================= */}
      <div className="h-9 bg-[#0a0d14] border-b border-[#141b28] flex items-center justify-between px-3">
        {/* Left: Brand Logo & Workspace Navigation Tabs */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-gradient-to-br from-cyan-400 via-blue-500 to-indigo-600 flex items-center justify-center font-black text-[10px] text-black shadow-xs shadow-cyan-500/30">
              EQ
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold tracking-wider text-[11px] text-slate-100 font-sans">
                EQO TERMINAL
              </span>
              <span className="text-[10px] font-bold text-cyan-400 font-mono tracking-widest">
                PRO
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400 animate-pulse ml-0.5" />
            </div>
          </div>

          {/* Workspace Tabs: [TRADE] [WATCHLIST] [OPTIONS] [ANALYTICS] */}
          <nav className="flex items-center gap-1 ml-2">
            {(["TRADE", "WATCHLIST", "OPTIONS", "ANALYTICS"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-2.5 py-1 text-[10px] font-mono tracking-wider font-semibold rounded transition-colors ${
                  activeTab === tab
                    ? "bg-[#131b2a] text-cyan-300 border border-cyan-700/60 shadow-xs"
                    : "text-slate-400 hover:text-slate-200 hover:bg-[#10141e]"
                }`}
              >
                [{tab}]
              </button>
            ))}
          </nav>
        </div>

        {/* Center: Global Omnibox Search */}
        <div className="relative flex items-center w-72">
          <form onSubmit={handleSearchSubmit} className="w-full">
            <div className="relative flex items-center">
              <span className="absolute left-2.5 text-slate-500 text-[10px]">🔍</span>
              <input
                type="text"
                placeholder="Quick symbol search..."
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setDropdownOpen(true);
                }}
                onFocus={() => setDropdownOpen(true)}
                className="w-full bg-[#101520] border border-[#1d273a] text-slate-100 placeholder-slate-500 text-[10px] pl-7 pr-14 py-1 rounded focus:outline-none focus:border-cyan-500 font-mono transition-colors"
              />
              <span className="absolute right-2 px-1 py-0.2 rounded bg-[#182133] border border-[#232f46] text-[8px] font-mono text-slate-400">
                ⌘K
              </span>
            </div>
          </form>

          {/* Search Dropdown */}
          {dropdownOpen && (
            <div
              className="absolute left-0 top-8 w-72 bg-[#0c1018] border border-[#1e293b] rounded shadow-2xl p-1 z-50 text-[11px]"
              onMouseLeave={() => setDropdownOpen(false)}
            >
              <div className="text-[9px] text-slate-500 px-2 py-1 uppercase tracking-wider font-mono">
                Popular US Equities
              </div>
              {[
                { sym: "QQQ", name: "Invesco QQQ Trust", chg: "-0.71%" },
                { sym: "SPY", name: "SPDR S&P 500 ETF", chg: "-0.06%" },
                { sym: "NVDA", name: "NVIDIA Corp.", chg: "+2.15%" },
                { sym: "AAPL", name: "Apple Inc.", chg: "+0.65%" },
                { sym: "TSLA", name: "Tesla, Inc.", chg: "-3.20%" },
                { sym: "MSFT", name: "Microsoft Corp.", chg: "+0.18%" },
                { sym: "AMD", name: "Advanced Micro Dev.", chg: "+1.85%" },
              ].map((item) => (
                <div
                  key={item.sym}
                  onClick={() => {
                    setActiveSymbol(item.sym);
                    setDropdownOpen(false);
                  }}
                  className="flex items-center justify-between px-2 py-1.5 hover:bg-[#141b27] rounded cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold text-slate-200">{item.sym}</span>
                    <span className="text-slate-500 text-[9px] truncate max-w-[110px]">{item.name}</span>
                  </div>
                  <span
                    className={`font-mono text-[9px] ${
                      item.chg.startsWith("+") ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {item.chg}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Connection Badge & Quick Utilities */}
        <div className="flex items-center gap-3">
          {/* Futu OpenD TCP connection pill */}
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#0f1522] border border-[#1c273c] rounded text-[10px] font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400" />
            <span className="text-slate-300">
              Futu OpenD: <span className="text-emerald-400 font-bold">Connected (11ms)</span>
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-cyan-400">
              Quota: {futuStatus.quotaUsed}/100
            </span>
          </div>

          {/* Quick utility icons */}
          <div className="flex items-center gap-1 text-slate-400 text-xs">
            <button className="p-1 hover:text-slate-200 hover:bg-[#141b27] rounded" title="Layout Switcher">
              ☷
            </button>
            <button className="p-1 hover:text-slate-200 hover:bg-[#141b27] rounded" title="Full Screen">
              ⛶
            </button>
            <button className="p-1 hover:text-slate-200 hover:bg-[#141b27] rounded" title="Settings">
              ⚙
            </button>
          </div>
        </div>
      </div>

      {/* =========================================================================
          Tier 2: Ticker Intelligence Banner & Real-time Account Overview (Height ~44px)
         ========================================================================= */}
      <div className="h-11 bg-[#0b0e16] px-3 flex items-center justify-between gap-3">
        {/* Left Card: Active Ticker Header Strip */}
        <div className="flex items-center gap-3">
          {/* Circular Badge Icon */}
          <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-blue-700 to-cyan-500 flex items-center justify-center text-white font-bold text-xs shadow-inner shadow-cyan-200/20">
            ▲
          </div>

          {/* Ticker & Full Name */}
          <div className="flex items-baseline gap-2">
            <span className="font-extrabold text-sm tracking-wide text-slate-100 font-sans">
              {activeSymbol}
            </span>
            <span className="text-[10px] text-slate-400 hidden md:inline truncate max-w-[180px]">
              ({symbolName})
            </span>
          </div>

          {/* Large Bold Price */}
          <span className="font-mono text-base font-extrabold tabular-nums text-slate-100 tracking-tight">
            ${activePrice}
          </span>

          {/* Change & Change % Badge */}
          <span
            className={`font-mono text-[10px] tabular-nums font-bold px-2 py-0.5 rounded border ${
              isUp
                ? "bg-emerald-950/80 text-emerald-300 border-emerald-700/60"
                : "bg-rose-950/80 text-rose-300 border-rose-700/60"
            }`}
          >
            {isUp ? "+" : ""}{activeChange} ({isUp ? "+" : ""}{activeChangePct}%)
          </span>

          {/* 4-Session Price Strip */}
          <div className="hidden xl:flex items-center gap-2 pl-3 border-l border-[#1a2233] text-[10px] font-mono text-slate-400">
            <span>
              Pre: <span className="text-slate-300 font-medium tabular-nums">${(currentQuote?.sessions?.preMarket?.price || 749.73).toFixed(2)}</span>
            </span>
            <span className="text-slate-600">|</span>
            <span>
              Reg: <span className="text-slate-300 font-medium tabular-nums">${(currentQuote?.sessions?.regular?.price || 746.04).toFixed(2)}</span>
            </span>
            <span className="text-slate-600">|</span>
            <span>
              After: <span className="text-slate-300 font-medium tabular-nums">${(currentQuote?.sessions?.afterMarket?.price || 743.90).toFixed(2)}</span>
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-cyan-300 font-bold flex items-center gap-1 bg-cyan-950/40 px-1.5 py-0.5 rounded border border-cyan-800/40">
              <span>Overnight:</span>
              <span>🌙 ${(currentQuote?.sessions?.overnight?.price || currentQuote?.price || 740.53).toFixed(2)}</span>
              <span className="text-[8px] text-cyan-400 uppercase font-sans">(Active)</span>
            </span>
          </div>
        </div>

        {/* Right Card: Real-time Account Overview Strip */}
        <div className="flex items-center gap-4 text-[10px] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">Cash:</span>
            <span className="text-slate-200 font-bold tabular-nums">
              ${(paperAccount?.cash || 100000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <span className="text-slate-700">|</span>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">Portfolio:</span>
            <span className="text-slate-200 font-bold tabular-nums">
              ${(paperAccount?.portfolioValue || 100846).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <span className="text-slate-700">|</span>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">P&L:</span>
            <span className="text-emerald-400 font-bold tabular-nums">
              +$846.00 (+0.84%)
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
