// Alpaca stock bar history (IEX feed). Used for minute history older than the local twenty-minute
// window, and for 5m, 15m, 1h, day, week and month. Responses are cached in memory per symbol and frame.
import { etDateKey } from './time.mjs';

const FRAME = Object.freeze({ '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1Hour', D: '1Day', W: '1Week', M: '1Month' });
const LOOKBACK_DAYS = Object.freeze({ '1m': 5, '5m': 30, '15m': 60, '1h': 180, D: 730, W: 2555, M: 3650 });
const TTL_MS = Object.freeze({ '1m': 60_000, '5m': 120_000, '15m': 300_000, '1h': 300_000, D: 3_600_000, W: 3_600_000, M: 3_600_000 });
const DAILY = new Set(['D', 'W', 'M']);
const DAY_MS = 86_400_000;

export class AlpacaBars {
  constructor({ key, secret, dataBase, feed }) {
    this.key = key;
    this.secret = secret;
    this.dataBase = dataBase;
    this.feed = feed;
    this.cache = new Map();
    this.inflight = new Map();
  }

  get configured() {
    return Boolean(this.key && this.secret);
  }

  async #json(url) {
    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': this.key, 'APCA-API-SECRET-KEY': this.secret, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`alpaca_http_${res.status}`);
    return res.json();
  }

  async #load(symbol, tf) {
    const end = new Date();
    const start = new Date(end.getTime() - LOOKBACK_DAYS[tf] * DAY_MS);
    const raw = [];
    let token = null;
    for (let page = 0; page < 40; page += 1) {
      const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, this.dataBase);
      url.searchParams.set('timeframe', FRAME[tf]);
      url.searchParams.set('start', start.toISOString());
      url.searchParams.set('end', end.toISOString());
      url.searchParams.set('limit', '10000');
      url.searchParams.set('adjustment', 'raw');
      url.searchParams.set('feed', this.feed);
      url.searchParams.set('sort', 'asc');
      if (token) url.searchParams.set('page_token', token);
      const body = await this.#json(url);
      raw.push(...(body.bars ?? []));
      token = body.next_page_token;
      if (!token) break;
    }
    const daily = DAILY.has(tf);
    return raw
      .map((b) => {
        const ms = Date.parse(b.t);
        return { t: daily ? etDateKey(ms) : Math.floor(ms / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: b.n };
      })
      .filter((b) => Number.isFinite(b.o) && Number.isFinite(b.c));
  }

  /** Historical bars for one symbol and frame, oldest first. */
  async history(symbol, tf) {
    if (!FRAME[tf]) throw new Error('unsupported_timeframe');
    const key = `${symbol}|${tf}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS[tf]) return hit.bars;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.#load(symbol, tf)
      .then((bars) => {
        this.cache.set(key, { at: Date.now(), bars });
        return bars;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }
}
