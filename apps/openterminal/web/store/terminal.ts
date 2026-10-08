"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeSymbol } from "../lib/symbol";

export type WidgetType =
  | "quote"
  | "chart"
  | "watchlist"
  | "news"
  | "heatmap"
  | "screener"
  | "crypto"
  | "macro"
  | "options"
  | "ivskew"
  | "optiontape"
  | "vertical"
  | "portfolio"
  | "ai"
  | "calendar"
  | "insider"
  | "tv"
  | "recap"
  | "researchpredictions";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  symbol?: string;
  linked: boolean; // follows the globally active symbol
};

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number };
export type OptionLeg = {
  symbol: string;
  side: "buy" | "sell";
  strike: number;
  right: "call" | "put";
};

type TerminalState = {
  activeSymbol: string;
  widgets: WidgetInstance[];
  layout: LayoutItem[];
  watchlist: string[];
  commandOpen: boolean;
  optionLegs: OptionLeg[];
  setActiveSymbol: (s: string) => void;
  setCommandOpen: (open: boolean) => void;
  selectOptionLeg: (contract: Omit<OptionLeg, "side">) => void;
  setOptionLegSide: (symbol: string, side: OptionLeg["side"]) => void;
  clearOptionLegs: () => void;
  addWidget: (type: WidgetType, symbol?: string) => void;
  removeWidget: (id: string) => void;
  setWidgetSymbol: (id: string, symbol: string) => void;
  toggleLinked: (id: string) => void;
  setLayout: (layout: LayoutItem[]) => void;
  addToWatchlist: (s: string) => void;
  removeFromWatchlist: (s: string) => void;
  resetWorkspace: () => void;
};

const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "w-chart", type: "chart", linked: true },
  { id: "w-options", type: "options", linked: true },
  { id: "w-quote", type: "quote", linked: true },
  { id: "w-watchlist", type: "watchlist", linked: false },
  { id: "w-ivskew", type: "ivskew", linked: true },
  { id: "w-optiontape", type: "optiontape", linked: true },
  { id: "w-vertical", type: "vertical", linked: true },
  { id: "w-news", type: "news", linked: true },
  { id: "w-macro", type: "macro", linked: false },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "w-chart", x: 0, y: 0, w: 7, h: 12 },
  { i: "w-quote", x: 7, y: 0, w: 5, h: 6 },
  { i: "w-watchlist", x: 7, y: 6, w: 5, h: 6 },
  { i: "w-options", x: 0, y: 12, w: 12, h: 11 },
  { i: "w-ivskew", x: 0, y: 23, w: 5, h: 8 },
  { i: "w-optiontape", x: 5, y: 23, w: 3, h: 8 },
  { i: "w-vertical", x: 8, y: 23, w: 4, h: 8 },
  { i: "w-news", x: 0, y: 31, w: 7, h: 7 },
  { i: "w-macro", x: 7, y: 31, w: 5, h: 7 },
];

const SIZE_BY_TYPE: Record<WidgetType, { w: number; h: number }> = {
  quote: { w: 5, h: 6 },
  chart: { w: 7, h: 12 },
  watchlist: { w: 4, h: 7 },
  news: { w: 5, h: 8 },
  heatmap: { w: 7, h: 10 },
  screener: { w: 12, h: 9 },
  crypto: { w: 6, h: 9 },
  macro: { w: 5, h: 7 },
  options: { w: 12, h: 9 },
  ivskew: { w: 5, h: 8 },
  optiontape: { w: 4, h: 8 },
  vertical: { w: 4, h: 9 },
  portfolio: { w: 7, h: 8 },
  ai: { w: 5, h: 10 },
  calendar: { w: 12, h: 11 },
  insider: { w: 7, h: 9 },
  tv: { w: 6, h: 11 },
  recap: { w: 5, h: 12 },
  researchpredictions: { w: 5, h: 12 },
};

export const useTerminal = create<TerminalState>()(
  persist(
    (set) => ({
      activeSymbol: "QQQ",
      widgets: DEFAULT_WIDGETS,
      layout: DEFAULT_LAYOUT,
      watchlist: ["QQQ", "SPY", "IWM", "NVDA", "TSLA", "AAPL", "MSFT", "GLD"],
      commandOpen: false,
      optionLegs: [],
      setActiveSymbol: (s) => {
        const sym = normalizeSymbol(s);
        if (sym) set({ activeSymbol: sym });
      },
      setCommandOpen: (open) => set({ commandOpen: open }),
      selectOptionLeg: (contract) => set((st) => {
        if (st.optionLegs.some((leg) => leg.symbol === contract.symbol)) {
          return { optionLegs: st.optionLegs.filter((leg) => leg.symbol !== contract.symbol) };
        }
        const leg: OptionLeg = {
          ...contract,
          side: st.optionLegs.length === 0 ? "buy" : "sell",
        };
        return { optionLegs: st.optionLegs.length >= 2 ? [leg] : [...st.optionLegs, leg] };
      }),
      setOptionLegSide: (symbol, side) => set((st) => ({
        optionLegs: st.optionLegs.map((leg) => leg.symbol === symbol ? { ...leg, side } : leg),
      })),
      clearOptionLegs: () => set({ optionLegs: [] }),
      addWidget: (type, symbol) =>
        set((st) => {
          const id = `w-${type}-${Date.now()}`;
          const size = SIZE_BY_TYPE[type];
          const maxY = st.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
          return {
            widgets: [...st.widgets, { id, type, symbol, linked: !symbol }],
            layout: [...st.layout, { i: id, x: 0, y: maxY, ...size }],
          };
        }),
      removeWidget: (id) =>
        set((st) => ({
          widgets: st.widgets.filter((w) => w.id !== id),
          layout: st.layout.filter((l) => l.i !== id),
        })),
      setWidgetSymbol: (id, symbol) => {
        const sym = normalizeSymbol(symbol);
        if (!sym) return;
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, symbol: sym, linked: false } : w)),
        }));
      },
      toggleLinked: (id) =>
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, linked: !w.linked } : w)),
        })),
      setLayout: (layout) => set({ layout }),
      addToWatchlist: (s) => {
        const sym = normalizeSymbol(s);
        if (!sym) return;
        set((st) => ({
          watchlist: st.watchlist.includes(sym) ? st.watchlist : [...st.watchlist, sym],
        }));
      },
      removeFromWatchlist: (s) => set((st) => ({ watchlist: st.watchlist.filter((x) => x !== s) })),
      resetWorkspace: () => set({ widgets: DEFAULT_WIDGETS, layout: DEFAULT_LAYOUT }),
    }),
    { name: "eqoboard-open-terminal-v1" }
  )
);

/** Symbol a widget should display: its own, or the active one when linked. */
export function useWidgetSymbol(widget: WidgetInstance): string {
  const active = useTerminal((s) => s.activeSymbol);
  return widget.linked ? active : widget.symbol ?? active;
}
