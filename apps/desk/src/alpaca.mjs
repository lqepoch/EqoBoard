// Alpaca options through REST. Market data uses the "indicative" feed, which Alpaca delays
// (15 minutes on the basic plan). Keys are read on the server only and never returned to the browser.
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function addDays(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export class AlpacaOptions {
  constructor({ key, secret, tradingBase, dataBase, feed }) {
    this.key = key;
    this.secret = secret;
    this.tradingBase = tradingBase;
    this.dataBase = dataBase;
    this.feed = feed;
    this.cache = new Map();
  }

  get configured() {
    return Boolean(this.key && this.secret);
  }

  async #json(url) {
    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': this.key, 'APCA-API-SECRET-KEY': this.secret, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`alpaca_http_${res.status}`);
    return res.json();
  }

  async #cached(key, ttlMs, load) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async #contracts(underlying, params) {
    const out = [];
    let token = null;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL('/v2/options/contracts', this.tradingBase);
      url.searchParams.set('underlying_symbols', underlying);
      url.searchParams.set('limit', '10000');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (token) url.searchParams.set('page_token', token);
      const body = await this.#json(url);
      out.push(...(body.option_contracts ?? []));
      token = body.next_page_token;
      if (!token) break;
    }
    return out;
  }

  /** Listed expiration dates for the next four months. */
  async expiries(underlying) {
    return this.#cached(`exp:${underlying}`, 10 * 60_000, async () => {
      const contracts = await this.#contracts(underlying, {
        expiration_date_gte: addDays(0),
        expiration_date_lte: addDays(120),
      });
      return [...new Set(contracts.map((c) => c.expiration_date))].sort();
    });
  }

  async #snapshots(underlying, expiry, type) {
    const out = {};
    let token = null;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`, this.dataBase);
      url.searchParams.set('feed', this.feed);
      url.searchParams.set('type', type);
      url.searchParams.set('expiration_date', expiry);
      url.searchParams.set('limit', '1000');
      if (token) url.searchParams.set('page_token', token);
      const body = await this.#json(url);
      Object.assign(out, body.snapshots ?? {});
      token = body.next_page_token;
      if (!token) break;
    }
    return out;
  }

  /** One expiry, calls and puts merged by OCC symbol. Quote times are the provider's (delayed) times. */
  async chain(underlying, expiry, spot) {
    return this.#cached(`chain:${underlying}:${expiry}`, 5_000, async () => {
      const contracts = await this.#contracts(underlying, { expiration_date: expiry });
      const [calls, puts] = await Promise.all([
        this.#snapshots(underlying, expiry, 'call'),
        this.#snapshots(underlying, expiry, 'put'),
      ]);
      const snaps = { ...calls, ...puts };
      const rows = contracts.map((c) => toRow(c, snaps[c.symbol] ?? null, spot)).sort((a, b) => a.strike - b.strike);
      return { underlying, expiry, feed: this.feed, rows };
    });
  }
}

function toRow(contract, snap, spot) {
  const q = snap?.latestQuote ?? {};
  const t = snap?.latestTrade ?? {};
  const g = snap?.greeks ?? {};
  const daily = snap?.dailyBar ?? null;
  const prev = snap?.prevDailyBar ?? null;
  const strike = num(contract.strike_price);
  const bid = num(q.bp);
  const ask = num(q.ap);
  const mid = bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : null;
  const last = num(t.p);
  const price = mid ?? last;
  const intrinsic =
    spot === null || strike === null ? null : contract.type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = price !== null && intrinsic !== null ? Math.max(price - intrinsic, 0) : null;
  return {
    symbol: contract.symbol,
    type: contract.type,
    strike,
    bid,
    bidSize: num(q.bs),
    ask,
    askSize: num(q.as),
    quoteAt: q.t ?? null,
    last,
    lastSize: num(t.s),
    lastAt: t.t ?? null,
    change: daily && prev && num(prev.c) ? ((num(daily.c) ?? 0) / num(prev.c) - 1) * 100 : null,
    volume: num(daily?.v),
    openInterest: num(contract.open_interest),
    iv: num(snap?.impliedVolatility),
    delta: num(g.delta),
    gamma: num(g.gamma),
    theta: num(g.theta),
    vega: num(g.vega),
    intrinsic,
    timeValue,
  };
}
