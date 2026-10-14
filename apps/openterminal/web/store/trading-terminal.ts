"use client";

import { create } from "zustand";

export type ChartType = "candles" | "line" | "area" | "bars";
export type IndicatorKey = "SMA20" | "SMA50" | "SMA200" | "EMA20" | "VWAP" | "BOLL" | "RSI" | "MACD" | "VOL";
export type ProviderMode = "auto" | "alpaca_only" | "futu_only";

export type StockQuote = {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  dayRange: { low: number; high: number };
  range52: { low: number; high: number; position: number };
  vwap: number;
  rsi: number;
  signal: "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
  timestamp: string;
  source: string;
  currentSession?: string;
  sessionLabel?: string;
  sessions?: {
    regular: { price: number; change: number; changePercent: number; volume: number };
    preMarket?: { price: number; change: number; changePercent: number; volume: number } | null;
    afterMarket?: { price: number; change: number; changePercent: number; volume: number } | null;
    overnight?: { price: number; change: number; changePercent: number; volume: number } | null;
  };
};

export type OrderBookEntry = {
  level: number;
  price: number;
  size: number;
  total: number;
};

export type OrderBook = {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPercent: number;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  timestamp: string;
};

export type TradeTick = {
  id: string;
  time: string;
  price: number;
  size: number;
  side: "BUY" | "SELL" | "NEUTRAL";
};

export type BarData = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change?: number;
  changePercent?: number;
};

export type PaperPosition = {
  symbol: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
};

export type PaperOrder = {
  id: string;
  time: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  price: number;
  shares: number;
  status: "FILLED" | "CANCELLED";
  totalValue: number;
};

export type PaperAccount = {
  cash: number;
  portfolioValue: number;
  positionsValue: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
};

export type WatchlistGroup = "ALL" | "MAG7" | "TECH" | "ETF" | "SEMI";

export const PRESET_GROUPS: Record<WatchlistGroup, string[]> = {
  ALL: ["QQQ", "SPY", "NVDA", "AAPL", "TSLA", "MSFT", "AMD", "AMZN", "META", "GOOGL", "IWM", "GLD"],
  MAG7: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"],
  TECH: ["NVDA", "AAPL", "MSFT", "AMD", "AMZN", "META", "GOOGL"],
  ETF: ["QQQ", "SPY", "IWM", "GLD"],
  SEMI: ["NVDA", "AMD"],
};

interface TradingState {
  activeSymbol: string;
  setActiveSymbol: (s: string) => void;
  
  // Watchlist
  watchlist: string[];
  activeGroup: WatchlistGroup;
  setActiveGroup: (group: WatchlistGroup) => void;
  addToWatchlist: (symbol: string) => void;
  removeFromWatchlist: (symbol: string) => void;
  watchlistQuotes: Record<string, Partial<StockQuote>>;

  // Charting controls
  chartType: ChartType;
  setChartType: (type: ChartType) => void;
  indicators: Record<IndicatorKey, boolean>;
  toggleIndicator: (ind: IndicatorKey) => void;
  providerMode: ProviderMode;
  setProviderMode: (mode: ProviderMode) => void;

  // Real-time market data
  currentQuote: StockQuote | null;
  orderBook: OrderBook | null;
  trades: TradeTick[];

  // Crosshair HUD hover data
  hoveredBar: (BarData & { change?: number; changePercent?: number }) | null;
  setHoveredBar: (bar: (BarData & { change?: number; changePercent?: number }) | null) => void;

  // Paper Trading
  paperAccount: PaperAccount;
  placeOrder: (order: { symbol: string; side: "BUY" | "SELL"; type: "MARKET" | "LIMIT"; shares: number; price: number }) => Promise<boolean>;

  // System & Environment
  dataSource: "futu" | "sip" | "demo";
  setDataSource: (source: "futu" | "sip" | "demo") => void;
  futuStatus: { connected: boolean; host: string; port: number; quotaUsed: number; quotaRemain: number };
  marketSession: "PRE" | "REGULAR" | "AFTER" | "CLOSED";
  countdown: number;
  setCountdown: (n: number) => void;

  // Sync actions
  fetchMarketData: () => Promise<void>;
  fetchAccountData: () => Promise<void>;
}

export const useTradingStore = create<TradingState>((set, get) => ({
  activeSymbol: "QQQ",
  setActiveSymbol: (s) => {
    const sym = s.trim().toUpperCase();
    if (!sym || sym === get().activeSymbol) return;
    set({ activeSymbol: sym, hoveredBar: null });
    get().fetchMarketData();
  },

  watchlist: PRESET_GROUPS.ALL,
  activeGroup: "ALL",
  setActiveGroup: (group) => {
    set({
      activeGroup: group,
      watchlist: PRESET_GROUPS[group] ?? PRESET_GROUPS.ALL,
    });
  },
  addToWatchlist: (s) => {
    const sym = s.trim().toUpperCase();
    if (!sym || get().watchlist.includes(sym)) return;
    set((state) => ({ watchlist: [sym, ...state.watchlist] }));
    get().fetchMarketData();
  },
  removeFromWatchlist: (sym) => {
    set((state) => ({
      watchlist: state.watchlist.filter((item) => item !== sym),
    }));
  },
  watchlistQuotes: {},

  chartType: "candles",
  setChartType: (chartType) => set({ chartType }),
  indicators: {
    SMA20: true,
    SMA50: true,
    SMA200: false,
    EMA20: false,
    VWAP: false,
    BOLL: true,
    RSI: false,
    MACD: false,
    VOL: true,
  },
  toggleIndicator: (ind) => {
    set((state) => ({
      indicators: { ...state.indicators, [ind]: !state.indicators[ind] },
    }));
  },
  providerMode: "auto",
  setProviderMode: (providerMode) => set({ providerMode }),

  currentQuote: null,
  orderBook: null,
  trades: [],
  hoveredBar: null,
  setHoveredBar: (bar) => set({ hoveredBar: bar }),

  paperAccount: {
    cash: 100000.0,
    portfolioValue: 100000.0,
    positionsValue: 0.0,
    positions: [],
    orders: [],
  },

  placeOrder: async ({ symbol, side, type, shares, price }) => {
    try {
      const res = await fetch("/api/futu/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, side, type, shares, price }),
      });
      if (res.ok) {
        await get().fetchAccountData();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  dataSource: "futu",
  setDataSource: (dataSource) => set({ dataSource }),
  futuStatus: {
    connected: true,
    host: "127.0.0.1",
    port: 11111,
    quotaUsed: 40,
    quotaRemain: 60,
  },
  marketSession: "REGULAR",
  countdown: 1,
  setCountdown: (countdown) => set({ countdown }),

  fetchMarketData: async () => {
    const symbol = get().activeSymbol;
    const watchlist = get().watchlist;
    try {
      // 1. 获取当前标的快照 (全时段支持)
      const qRes = await fetch(`/api/futu/quote?symbol=${encodeURIComponent(symbol)}`);
      if (qRes.ok) {
        const quote = await qRes.json();
        set({ currentQuote: quote });
      }

      // 2. 获取盘口 (极速 1s 高频刷新)
      const obRes = await fetch(`/api/futu/orderbook?symbol=${encodeURIComponent(symbol)}`);
      if (obRes.ok) {
        const ob = await obRes.json();
        set({ orderBook: ob });
      }

      // 3. 获取逐笔流水 (高频毫秒流水，对齐当前实际时间)
      const trRes = await fetch(`/api/futu/trades?symbol=${encodeURIComponent(symbol)}`);
      if (trRes.ok) {
        const trData = await trRes.json();
        set({ trades: trData.trades || [] });
      }

      // 4. 批量刷新自选股列表
      const listSymbols = Array.from(new Set([symbol, ...watchlist]));
      const listRes = await fetch(`/api/futu/quotes?symbols=${encodeURIComponent(listSymbols.join(","))}`);
      if (listRes.ok) {
        const listData = await listRes.json();
        const map: Record<string, Partial<StockQuote>> = {};
        for (const item of listData) {
          map[item.symbol] = item;
        }
        set({ watchlistQuotes: map });
      }
    } catch (e) {
      console.error("fetchMarketData error", e);
    }
  },

  fetchAccountData: async () => {
    try {
      const res = await fetch("/api/futu/account");
      if (res.ok) {
        const account = await res.json();
        set({ paperAccount: account });
      }
    } catch (e) {
      console.error("fetchAccountData error", e);
    }
  },
}));
