"use client";

import React, { useState, useEffect } from "react";
import { useTradingStore } from "../../store/trading-terminal";

export default function TerminalStatusBar() {
  const { fetchMarketData } = useTradingStore();

  const [localTime, setLocalTime] = useState("");
  const [etTime, setEtTime] = useState("");

  useEffect(() => {
    let tickCount = 0;
    const timer = setInterval(() => {
      const now = new Date();
      setLocalTime(now.toTimeString().split(" ")[0]);
      setEtTime(
        now.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );

      // 每秒刷新盘口、当前价、逐笔流水
      fetchMarketData();

      // 每 3 秒同步一次 K 线走势与动态聚合数据
      tickCount++;
      if (tickCount % 3 === 0) {
        useTradingStore.getState().fetchKlineData();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [fetchMarketData]);

  return (
    <footer className="h-6 bg-[#07090e] border-t border-[#141b28] px-3 flex items-center justify-between text-[10px] font-mono select-none text-slate-400 z-30 shrink-0">
      {/* 左侧: 数据源与连接 */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400" />
          <span className="text-slate-300">
            FUTU OPEND 127.0.0.1:11111{" "}
            <span className="text-emerald-400 font-bold">[TCP CONNECTED]</span>
          </span>
        </div>

        <span className="text-slate-700 hidden sm:inline">|</span>

        {/* 180天本地缓存状态 */}
        <div className="hidden md:flex items-center gap-1 text-emerald-400 font-semibold">
          180D CACHE READY
        </div>

        <span className="text-slate-700 hidden sm:inline">|</span>

        {/* 图表引擎版本 */}
        <span className="hidden md:inline text-slate-400">
          ENGINE:{" "}
          <span className="text-slate-200 font-semibold">
            Lightweight Charts™ v5.0.0
          </span>
        </span>
      </div>

      {/* 右侧: 双时区时钟与网络延迟 */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-slate-500">NY:</span>
          <span className="text-slate-200 tabular-nums font-semibold">{etTime || "03:32:06"} EDT</span>
        </div>

        <span className="text-slate-700">|</span>

        <div className="flex items-center gap-1">
          <span className="text-slate-500">Local:</span>
          <span className="text-slate-200 tabular-nums font-semibold">{localTime || "15:32:06"} HKT</span>
        </div>

        <span className="text-slate-700">|</span>

        <div className="flex items-center gap-1">
          <span className="text-slate-500">Latency:</span>
          <span className="text-emerald-400 font-bold tabular-nums">11ms</span>
        </div>
      </div>
    </footer>
  );
}
