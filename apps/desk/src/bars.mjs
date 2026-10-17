import { LOCAL_MINUTE_MS, SECOND_FRAMES } from './cache.mjs';

// Frames built from a base frame. 10m and 30m align with New York clock marks; 2h and 4h align to UTC.
const DERIVED = Object.freeze({
  '10m': { base: '5m', secs: 600 },
  '30m': { base: '15m', secs: 1800 },
  '2h': { base: '1h', secs: 7200 },
  '4h': { base: '1h', secs: 14400 },
});
export const TIMEFRAMES = Object.freeze(['1s', '5s', '10s', '1m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', 'D', 'W', 'M']);

export function aggregate(bars, secs) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.t / secs) * secs;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v = last.v === null || b.v === null ? null : last.v + b.v;
    } else {
      out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  }
  return out;
}

/**
 * Minute history: Alpaca for everything older than the local window, local Futu bars for the window.
 * Without Alpaca credentials only the local window is available; the caller labels that case.
 */
async function minuteBars(ctx, symbol, limit, nowMs) {
  const local = ctx.cache.bars(symbol, 60, 60);
  if (!ctx.alpaca.configured) return { bars: local.slice(-limit), localOnly: true };
  const cutoff = Math.floor((nowMs - LOCAL_MINUTE_MS) / 60_000) * 60;
  const history = await ctx.alpaca.history(symbol, '1m');
  const localStart = local.length ? local[0].t : Infinity;
  const older = history.filter((b) => b.t < cutoff);
  const gap = history.filter((b) => b.t >= cutoff && b.t < localStart);
  return { bars: [...older, ...gap, ...local].slice(-limit), localOnly: false };
}

/**
 * Returns the bars for one frame. Seconds frames come only from the local cache;
 * minute frames combine Alpaca history with the local window; the rest come from Alpaca.
 */
export async function loadBars(ctx, symbol, tf, limit, nowMs = Date.now()) {
  if (SECOND_FRAMES[tf]) {
    return {
      tf,
      source: 'Futu 逐笔，本地聚合（最长 1 小时）',
      bars: ctx.cache.bars(symbol, SECOND_FRAMES[tf], limit),
    };
  }
  if (tf === '1m') {
    const { bars, localOnly } = await minuteBars(ctx, symbol, limit, nowMs);
    return {
      tf,
      localOnly,
      source: localOnly
        ? '富途逐笔本地聚合 · 仅最近 20 分钟（未配置 Alpaca 历史）'
        : 'Alpaca 历史 · 最近 20 分钟为富途逐笔本地聚合',
      bars,
    };
  }
  if (DERIVED[tf]) {
    const base = await loadBars(ctx, symbol, DERIVED[tf].base, Number.MAX_SAFE_INTEGER, nowMs);
    return {
      tf,
      source: `Alpaca 历史（由 ${DERIVED[tf].base} 聚合）`,
      bars: aggregate(base.bars, DERIVED[tf].secs).slice(-limit),
    };
  }
  const bars = await ctx.alpaca.history(symbol, tf);
  return { tf, source: 'Alpaca 历史', bars: bars.slice(-limit) };
}
