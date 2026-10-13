"use client";

import React, { useState, useEffect } from "react";
import TerminalHeader from "./TerminalHeader";
import WatchlistPanel from "./WatchlistPanel";
import MainChartPanel from "./MainChartPanel";
import OrderBookPanel from "./OrderBookPanel";
import PaperTradingPanel from "./PaperTradingPanel";
import TerminalStatusBar from "./TerminalStatusBar";
import { useTradingStore } from "../../store/trading-terminal";

export default function ModernTerminal({
  researchOrigin,
  onSwitchToWorkspace,
}: {
  researchOrigin?: string | null;
  onSwitchToWorkspace?: () => void;
}) {
  const { fetchMarketData, fetchKlineData, fetchAccountData } = useTradingStore();
  const [selectedBookPrice, setSelectedBookPrice] = useState<number | null>(null);

  // 初始化加载所有核心量化行情与账户状态
  useEffect(() => {
    fetchMarketData();
    fetchKlineData();
    fetchAccountData();
  }, [fetchMarketData, fetchKlineData, fetchAccountData]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-[#07090e] text-slate-100 font-sans antialiased">
      {/* 顶部企业级 Header: 两级导航与标的/账户 Overview */}
      <TerminalHeader onSwitchToWorkspace={onSwitchToWorkspace} />

      {/* 主体三栏响应式网格 (Watchlist | Main Chart & Studies | Order Book & Execution) */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* 左栏: Watchlist 自选股面板 (~320px) */}
        <WatchlistPanel />

        {/* 中栏: 主图表与量化指标看板 (Flex 1) */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <MainChartPanel />
        </main>

        {/* 右栏: 盘口与交易执行 (~340px) */}
        <aside className="w-84 bg-[#0a0d14] border-l border-[#141b28] flex flex-col h-full shrink-0 overflow-hidden">
          {/* 上半部分: Level 2 深度盘口 & 逐笔成交 (高度 48%) */}
          <div className="h-[48%] min-h-0 overflow-hidden">
            <OrderBookPanel onSelectPrice={(price) => setSelectedBookPrice(price)} />
          </div>

          {/* 下半部分: Institutional Execution Ticket 交易执行票据与持仓 (高度 52%) */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <PaperTradingPanel selectedPrice={selectedBookPrice} />
          </div>
        </aside>
      </div>

      {/* 底部高对比度状态栏 */}
      <TerminalStatusBar />
    </div>
  );
}
