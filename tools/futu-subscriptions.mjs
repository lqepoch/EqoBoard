// Futu stock quota is security x type. Options have a separate chain-based quota.
// This stock-only allocator never operates another OpenD connection's subscriptions.
export const PINNED_STOCKS = Object.freeze(['QQQ', 'SPY']);
export const STOCK_TYPES = Object.freeze([1, 2, 4]); // QUOTE, ORDER_BOOK, TICKER
export class StockSubscriptions {
  constructor(sdk, { now = Date.now, capacity = 30, quota = 100 } = {}) {
    this.sdk = sdk; this.now = now; this.capacity = capacity; this.quota = quota;
    this.entries = new Map(); this.active = new Set(PINNED_STOCKS);
  }
  async update(symbols) {
    if (!Array.isArray(symbols) || symbols.length > 32 ||
      symbols.some(s => typeof s !== 'string' || !/^[A-Z][A-Z0-9.-]{0,11}$/.test(s))) {
      throw new Error('invalid_symbols');
    }
    const wanted = new Set([...PINNED_STOCKS, ...symbols]);
    if ([...wanted].filter(s => !PINNED_STOCKS.includes(s)).length > this.capacity) {
      throw new Error('stock_buffer_full');
    }
    this.active = wanted;
    for (const symbol of wanted) {
      const entry = this.entries.get(symbol);
      if (entry) entry.touched = this.now();
    }
    for (const symbol of wanted) {
      if (this.entries.has(symbol)) continue;
      let info = await this.sdk.GetSubInfo({ c2s: { isReqAllConn: true } });
      this.check(info);
      if (!info.s2c || !Number.isSafeInteger(info.s2c.remainQuota) || !Number.isSafeInteger(info.s2c.totalUsedQuota)) {
        throw new Error('quota_unknown');
      }
      const extras = () => [...this.entries.keys()].filter(s => !PINNED_STOCKS.includes(s)).length;
      while (info.s2c.remainQuota < STOCK_TYPES.length ||
        info.s2c.totalUsedQuota + STOCK_TYPES.length > this.quota ||
        (!PINNED_STOCKS.includes(symbol) && extras() >= this.capacity)) {
        const candidate = [...this.entries].filter(([s, e]) =>
          !wanted.has(s) && !PINNED_STOCKS.includes(s) && this.now() - e.since >= 60_000)
          .sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!candidate) throw new Error('quota_waiting_for_release');
        const [old] = candidate;
        this.check(await this.sdk.Sub({ c2s: { securityList: [{ market: 11, code: old }],
          subTypeList: STOCK_TYPES, isSubOrUnSub: false, isRegOrUnRegPush: true } }));
        this.entries.delete(old);
        info = await this.sdk.GetSubInfo({ c2s: { isReqAllConn: true } });
        this.check(info);
        if (!info.s2c || !Number.isSafeInteger(info.s2c.remainQuota) || !Number.isSafeInteger(info.s2c.totalUsedQuota)) {
          throw new Error('quota_unknown');
        }
      }
      this.check(await this.sdk.Sub({ c2s: { securityList: [{ market: 11, code: symbol }],
        subTypeList: STOCK_TYPES, isSubOrUnSub: true, isRegOrUnRegPush: true, isFirstPush: false } }));
      this.entries.set(symbol, { since: this.now(), touched: this.now() });
    }
    return { active: [...wanted], buffered: [...this.entries.keys()], stock_quota_cap: this.quota };
  }
  check(response) {
    if (!response || response.retType !== 0) throw new Error('futu_request_rejected');
  }
}
