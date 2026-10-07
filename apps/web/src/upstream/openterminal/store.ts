/**
 * Adapted from ErTasselli/OpenTerminal web/store/terminal.ts
 * pinned at aed097c680cd8ec1c391ae06966babe7d6d91fc6 (MIT).
 * Modifications: EqoBoard widget types/defaults, order-safe ticker validation,
 * global symbol bridge, unique instance IDs and localStorage namespace.
 * Original license in third_party/OpenTerminal-LICENSE.txt.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeSymbol } from "./symbol";
import { useUi } from "../../state";

export type WidgetType = "quote" | "chart" | "watchlist" | "options" | "iv" | "tape" | "vertical";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  symbol?: string;
  linked: boolean; // follows the globally active symbol
};

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number };

type TerminalState = {
  activeSymbol: string;
  widgets: WidgetInstance[];
  layout: LayoutItem[];
  watchlist: string[];
  commandOpen: boolean;
  setActiveSymbol: (s: string) => void;
  setCommandOpen: (open: boolean) => void;
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
  { id: "w-watchlist", type: "watchlist", linked: true },
  { id: "w-chart", type: "chart", linked: true },
  { id: "w-vertical", type: "vertical", linked: true },
  { id: "w-options", type: "options", linked: true },
  { id: "w-iv", type: "iv", linked: true },
  { id: "w-tape", type: "tape", linked: true }
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "w-watchlist", x: 0, y: 0, w: 3, h: 5 },
  { i: "w-chart", x: 3, y: 0, w: 6, h: 5 },
  { i: "w-vertical", x: 9, y: 0, w: 3, h: 5 },
  { i: "w-options", x: 0, y: 5, w: 8, h: 8 },
  { i: "w-iv", x: 8, y: 5, w: 4, h: 4 },
  { i: "w-tape", x: 8, y: 9, w: 4, h: 4 }
];

const SIZE_BY_TYPE: Record<WidgetType, { w: number; h: number }> = {
  quote: {w:4,h:4}, chart:{w:6,h:6}, watchlist:{w:3,h:6},
  options:{w:8,h:8}, iv:{w:4,h:4}, tape:{w:4,h:4}, vertical:{w:4,h:6}
};

export const useTerminal = create<TerminalState>()(
  persist(
    (set) => ({
      activeSymbol: "QQQ",
      widgets: DEFAULT_WIDGETS,
      layout: DEFAULT_LAYOUT,
      watchlist: ["SPY", "QQQ", "IWM", "NVDA", "TSLA"],
      commandOpen: false,
      setActiveSymbol: (s) => {
        const sym = normalizeSymbol(s);
        if (sym) {
          if (useUi.getState().selectedSymbol !== sym) useUi.getState().setSymbol(sym);
          set((st) => st.activeSymbol === sym ? st : {activeSymbol: sym});
        }
      },
      setCommandOpen: (open) => set({ commandOpen: open }),
      addWidget: (type, symbol) =>
        set((st) => {
          const id = `w-${type}-${crypto.randomUUID()}`;
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
    { name: "eqoboard:openterminal-workspace-v1" }
  )
);

/** Symbol a widget should display: its own, or the active one when linked. */
export function useWidgetSymbol(widget: WidgetInstance): string {
  const active = useTerminal((s) => s.activeSymbol);
  return widget.linked ? active : widget.symbol ?? active;
}
