"use client";

import ChartWidget from "../widgets/ChartWidget";

export default function YfinanceResearchChartPage({ symbol }: { symbol: string }) {
  return (
    <main className="min-h-screen bg-[#080b11] text-slate-100 p-3 md:p-5" data-testid="yfinance-research-page">
      <header className="mx-auto max-w-[1600px] border-b border-[#1a2233] pb-3 mb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-amber-400">Isolated Research · Yahoo Finance</p>
            <h1 className="mt-1 text-lg font-semibold">{symbol} daily historical observation</h1>
          </div>
          <span className="text-[10px] font-mono text-amber-300" data-testid="yfinance-research-display-only">
            DISPLAY ONLY · NOT RAW-CONFIRMED · NOT POINT-IN-TIME
          </span>
        </div>
        <p className="mt-2 max-w-5xl text-[11px] leading-relaxed text-slate-400">
          Yahoo’s adjustment basis and historical completeness are unverified. Values are binary-float chart projections;
          no exchange-calendar gap assessment, canonical history, or executable price is asserted. This page requests
          Yahoo daily history only and never combines it with terminal provider bars.
        </p>
      </header>
      <section className="mx-auto h-[calc(100vh-145px)] min-h-[520px] max-w-[1600px] border border-[#1a2233]" aria-label="Yahoo daily research chart">
        <ChartWidget
          widget={{ id: "yfinance-research-chart", type: "chart", symbol, linked: false }}
          historyMode="yfinance-research"
          symbolOverride={symbol}
        />
      </section>
    </main>
  );
}
