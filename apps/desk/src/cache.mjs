// Local cache of live Futu trades, aggregated on arrival.
// - Base seconds frame (1s): kept for one hour. 5s and 10s are derived from it on read, never from raw trades.
// - Base minute frame (1m): kept for the last twenty minutes; older minute history comes from Alpaca.
// Only trades flagged movesPrice move the price: continuous automatch prints that pass the jump guard
// in price-filter.mjs. Other prints (odd lots, average-price, contingent, outliers) add volume at the
// previous price, so an off-market print cannot draw a spike. Raw trades are kept only for the
// recent-trades list.
export const SECOND_FRAMES = Object.freeze({ '1s': 1, '5s': 5, '10s': 10 });
export const LOCAL_MINUTE_MS = 20 * 60_000;
const HOUR_S = 3600;
const MINUTE_WINDOW_S = 20 * 60;
const RAW_TRADES = 300;
const GAP_FILL_MAX_S = 60;
const FRAMES = [
  { secs: 1, windowS: HOUR_S },
  { secs: 60, windowS: MINUTE_WINDOW_S },
];

function addToFrame(frame, secs, windowS, trade, nowS) {
  const bucket = Math.floor(trade.ms / 1000 / secs) * secs;
  const last = frame[frame.length - 1];
  if (last && bucket < last.t) return;
  // Non-automatch prints carry the previous price; with no previous price they are skipped.
  const price = trade.movesPrice ? trade.price : (last ? last.c : null);
  if (price === null) return;
  if (last && bucket === last.t) {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
    last.v += trade.size;
    last.n += 1;
    return;
  }
  // Seconds frames carry the previous price across short silent gaps, with zero volume.
  if (last && secs < 60 && bucket - last.t <= GAP_FILL_MAX_S) {
    for (let t = last.t + secs; t < bucket; t += secs) {
      frame.push({ t, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, n: 0, filled: true });
    }
  }
  frame.push({ t: bucket, o: price, h: price, l: price, c: price, v: trade.size, n: 1 });
  const cutoff = nowS - windowS;
  while (frame.length && frame[0].t < cutoff) frame.shift();
}

/** Aggregates a seconds frame into a coarser seconds frame (5s or 10s) on read. */
function deriveFrom(frame, secs) {
  const out = [];
  for (const b of frame) {
    const t = Math.floor(b.t / secs) * secs;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
      last.n += b.n;
      last.filled = Boolean(last.filled && b.filled);
    } else {
      out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: b.n, filled: Boolean(b.filled) });
    }
  }
  return out;
}

export class TickCache {
  constructor() {
    this.symbols = new Map();
  }

  #entry(symbol) {
    let entry = this.symbols.get(symbol);
    if (!entry) {
      entry = { trades: [], frames: new Map(FRAMES.map((f) => [f.secs, []])), added: 0 };
      this.symbols.set(symbol, entry);
    }
    return entry;
  }

  add(symbol, trade) {
    const entry = this.#entry(symbol);
    const nowS = Math.floor(trade.ms / 1000);
    entry.trades.push(trade);
    if (entry.trades.length > RAW_TRADES) entry.trades.splice(0, entry.trades.length - RAW_TRADES);
    entry.added += 1;
    for (const f of FRAMES) addToFrame(entry.frames.get(f.secs), f.secs, f.windowS, trade, nowS);
  }

  /** Last `limit` bars of one frame, oldest first. 5s and 10s are derived from the 1s base. */
  bars(symbol, secs, limit) {
    const entry = this.symbols.get(symbol);
    if (!entry) return [];
    if (secs === 1 || secs === 60) return entry.frames.get(secs).slice(-limit);
    if (secs === 5 || secs === 10) return deriveFrom(entry.frames.get(1), secs).slice(-limit);
    return [];
  }

  /** Restores persisted bars that are still inside their window; trades resume live. */
  restore(symbol, frames, nowS) {
    const entry = this.#entry(symbol);
    for (const f of FRAMES) {
      const saved = frames?.[f.secs];
      if (!Array.isArray(saved)) continue;
      const cutoff = nowS - f.windowS;
      const frame = entry.frames.get(f.secs);
      for (const b of saved) {
        if (b && Number.isFinite(b.t) && b.t >= cutoff && (frame.length === 0 || b.t > frame[frame.length - 1].t)) frame.push(b);
      }
    }
  }

  /** Plain-object snapshot of the base frames, for the on-disk cache. */
  snapshot() {
    const out = {};
    for (const [symbol, entry] of this.symbols) {
      out[symbol] = Object.fromEntries([...entry.frames].map(([secs, bars]) => [secs, bars]));
    }
    return out;
  }

  recentTrades(symbol, n) {
    return (this.symbols.get(symbol)?.trades ?? []).slice(-n);
  }

  stats() {
    return [...this.symbols.entries()].map(([symbol, e]) => ({
      symbol,
      trades: e.trades.length,
      bars1s: e.frames.get(1).length,
      bars1m: e.frames.get(60).length,
    }));
  }
}
