// Read-only Futu OpenD client for the desk. Call shapes follow the repo's tools/futu-stdio.mjs
// and tools/futu-subscriptions.mjs (QUOTE=1, ORDER_BOOK=2, TICKER=4; QQQ and SPY are pinned).
// Unlike the gateway path, it keeps the full order book and the ticker direction field.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PriceFilter } from './price-filter.mjs';

const require = createRequire(import.meta.url);
const SDK = require('futu-api').default;
const { ftCmdID } = require('futu-api');
const protoRoot = require('futu-api/proto');

export const MARKET_US = 11;
export const PINNED = Object.freeze(['QQQ', 'SPY']);
const SUB_TYPES = Object.freeze([1, 2, 4]);
const EXTRA_CAPACITY = 30;
const QUOTA = 100;
const TRADE_BUFFER = 300;
const HISTORY_GAP_MS = 600;

const KL = protoRoot.lookupEnum('Qot_Common.KLType').values;
const REHAB_NONE = protoRoot.lookupEnum('Qot_Common.RehabType').values.RehabType_None;
const SESSION_ALL = protoRoot.lookupEnum('Common.Session').values.Session_ALL;
// Futu's ticker direction says which side of the book the print hit (Bid = at best bid,
// Ask = at best ask). It is passed through as reported and is not translated into buy or sell.
const DIR = protoRoot.lookupEnum('Qot_Common.TickerDirection').values;
const DIR_BID = DIR.TickerDirection_Bid;
const DIR_ASK = DIR.TickerDirection_Ask;
// Odd-lot prints (sub-100-share fills) report integer `volume` rounded to 0 or 1; `hpVolume`
// carries the exact fractional size, so the desk reads that field.
const TICKER_TYPE = protoRoot.lookupEnum('Qot_Common.TickerType').values;
const TICKER_ODD_LOT = TICKER_TYPE.TickerType_OddLot;
// Reverse map so each print carries its named type (for example Late, Delay, OddLot).
const TICKER_TYPE_NAME = Object.fromEntries(Object.entries(TICKER_TYPE).map(([k, v]) => [v, k.replace('TickerType_', '')]));

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const big = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v.toString());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const isoFromSec = (v) => {
  const s = num(v);
  return s !== null && s > 0 ? new Date(s * 1000).toISOString() : null;
};

function basicRow(row) {
  return {
    symbol: row.security.code,
    last: num(row.curPrice),
    prevClose: num(row.lastClosePrice),
    open: num(row.openPrice),
    high: num(row.highPrice),
    low: num(row.lowPrice),
    volume: big(row.volume),
    turnover: num(row.turnover),
    updatedAt: isoFromSec(row.updateTimestamp),
  };
}

export class FutuFeed extends EventEmitter {
  constructor({ host, port, ssl, key, log }) {
    super();
    this.cfg = { host, port, ssl, key };
    this.log = log;
    this.connected = false;
    this.loginError = null;
    this.quota = null;
    this.subs = new Map();
    this.trades = new Map();
    this.depth = new Map();
    this.quotes = new Map();
    this.seq = 0;
    this.priceFilter = new PriceFilter();
    this.lastHistoryAt = 0;
    this.sdk = new SDK();
    this.sdk.onlogin = (ok) => this.#onLogin(ok);
    this.sdk.onPush = (cmd, res) => this.#onPush(cmd, res);
  }

  start() {
    this.sdk.start(this.cfg.host, this.cfg.port, this.cfg.ssl, this.cfg.key);
  }

  stop() {
    this.sdk.stop();
  }

  status() {
    return {
      connected: this.connected,
      error: this.loginError,
      quota: this.quota,
      pinned: PINNED,
      subscribed: [...this.subs.keys()],
      tickerDirection: Number.isSafeInteger(DIR_BID) && Number.isSafeInteger(DIR_ASK),
    };
  }

  #onLogin(ok) {
    this.connected = Boolean(ok);
    this.loginError = ok ? null : 'futu_login_rejected';
    this.emit('status', this.status());
    if (ok) {
      this.subs.clear();
      this.watch([]).catch((err) => this.log('pinned subscription failed', err.message));
    }
  }

  #onPush(cmd, res) {
    if (!this.connected || !res || res.retType !== 0 || !res.s2c) return;
    const d = res.s2c;
    if (cmd === ftCmdID.QotUpdateTicker.cmd) this.#ticker(d);
    else if (cmd === ftCmdID.QotUpdateOrderBook.cmd) this.#book(d);
    else if (cmd === ftCmdID.QotUpdateBasicQot.cmd) this.#basic(d);
  }

  #activeSymbol(security) {
    if (!security || security.market !== MARKET_US) return null;
    return this.subs.has(security.code) ? security.code : null;
  }

  #ticker(d) {
    const symbol = this.#activeSymbol(d.security);
    if (!symbol) return;
    for (const t of d.tickerList ?? []) {
      const price = num(t.price);
      const size = num(t.hpVolume) ?? big(t.volume);
      const ms = num(t.timestamp) !== null ? Math.round(t.timestamp * 1000) : null;
      if (price === null || price <= 0 || size === null || size <= 0 || ms === null || t.pushDataType !== 1) continue;
      const dir = t.dir === DIR_ASK ? 'ask' : t.dir === DIR_BID ? 'bid' : 'neutral';
      const tickType = TICKER_TYPE_NAME[t.type] ?? String(t.type);
      const trade = {
        symbol,
        price,
        size,
        dir,
        oddLot: t.type === TICKER_ODD_LOT,
        tickType,
        // Whether this print may move the chart price (automatch and not a jump outlier); see price-filter.mjs.
        movesPrice: this.priceFilter.judge(symbol, { price, tickType }),
        ms,
        seq: (this.seq += 1),
      };
      const buffer = this.trades.get(symbol) ?? [];
      buffer.push(trade);
      if (buffer.length > TRADE_BUFFER) buffer.splice(0, buffer.length - TRADE_BUFFER);
      this.trades.set(symbol, buffer);
      this.emit('trade', trade);
    }
  }

  #book(d) {
    const symbol = this.#activeSymbol(d.security);
    if (!symbol) return;
    const level = (x) => ({ price: num(x.price), size: big(x.volume), orders: big(x.orederCount ?? x.orderCount) });
    const keep = (x) => x.price !== null && x.size !== null;
    const snapshot = {
      symbol,
      bids: (d.orderBookBidList ?? []).map(level).filter(keep).slice(0, 10),
      asks: (d.orderBookAskList ?? []).map(level).filter(keep).slice(0, 10),
      receivedAt: new Date().toISOString(),
      seq: (this.seq += 1),
    };
    this.depth.set(symbol, snapshot);
    this.emit('depth', snapshot);
  }

  #basic(d) {
    for (const row of d.basicQotList ?? []) {
      const symbol = this.#activeSymbol(row.security);
      if (!symbol) continue;
      const quote = { ...basicRow(row), seq: (this.seq += 1) };
      this.quotes.set(symbol, quote);
      this.emit('quote', quote);
    }
  }

  async #subInfo() {
    const res = await this.sdk.GetSubInfo({ c2s: { isReqAllConn: true } });
    if (!res || res.retType !== 0 || !res.s2c) throw new Error('futu_request_rejected');
    this.quota = { used: res.s2c.totalUsedQuota, remain: res.s2c.remainQuota };
    return this.quota;
  }

  async #sub(symbol, on) {
    const res = await this.sdk.Sub({
      c2s: {
        securityList: [{ market: MARKET_US, code: symbol }],
        subTypeList: SUB_TYPES,
        isSubOrUnSub: on,
        isRegOrUnRegPush: true,
        isFirstPush: false,
      },
    });
    if (!res || res.retType !== 0) throw new Error('futu_request_rejected');
  }

  /** Ensures QQQ and SPY plus the requested symbols are subscribed. */
  async watch(symbols) {
    if (!this.connected) throw new Error('futu_disconnected');
    const extraCurrent = [...this.subs.keys()].filter((s) => !PINNED.includes(s)).length;
    const extraAdded = symbols.filter((s) => !PINNED.includes(s) && !this.subs.has(s)).length;
    if (extraCurrent + extraAdded > EXTRA_CAPACITY) throw new Error('stock_buffer_full');
    const wanted = [...new Set([...PINNED, ...symbols])];
    for (const symbol of wanted) {
      if (this.subs.has(symbol)) continue;
      const quota = await this.#subInfo();
      if (quota.remain < SUB_TYPES.length || quota.used + SUB_TYPES.length > QUOTA) {
        throw new Error('quota_unavailable');
      }
      await this.#sub(symbol, true);
      this.subs.set(symbol, { since: Date.now() });
    }
    return [...this.subs.keys()];
  }

  async snapshot(symbols) {
    if (!this.connected) throw new Error('futu_disconnected');
    const rows = [];
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      const res = await this.sdk.GetBasicQot({
        c2s: { securityList: chunk.map((code) => ({ market: MARKET_US, code })) },
      });
      if (!res || res.retType !== 0 || !res.s2c) throw new Error('futu_read_failed');
      rows.push(...res.s2c.basicQotList.map(basicRow));
    }
    return rows;
  }

  /** Paged history. Futu intraday bars use the extended session; daily and longer use regular. */
  async kline(symbol, klName, beginDate, endDate, session) {
    if (!this.connected) throw new Error('futu_disconnected');
    const klType = KL[klName];
    if (!Number.isSafeInteger(klType)) throw new Error('unsupported_timeframe');
    const rows = [];
    let nextReqKey = null;
    for (let page = 0; page < 8; page += 1) {
      const wait = this.lastHistoryAt + HISTORY_GAP_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastHistoryAt = Date.now();
      const c2s = {
        rehabType: REHAB_NONE,
        klType,
        security: { market: MARKET_US, code: symbol },
        beginTime: beginDate,
        endTime: endDate,
        maxAckKLNum: 1000,
      };
      if (session === 'ALL') c2s.session = SESSION_ALL;
      if (nextReqKey) c2s.nextReqKey = nextReqKey;
      const res = await this.sdk.RequestHistoryKL({ c2s });
      if (!res || res.retType !== 0 || !res.s2c) throw new Error('futu_read_failed');
      rows.push(...(res.s2c.klList ?? []));
      nextReqKey = res.s2c.nextReqKey && res.s2c.nextReqKey.length ? res.s2c.nextReqKey : null;
      if (!nextReqKey) break;
    }
    return rows.map((k) => ({
      time: k.time,
      o: num(k.openPrice),
      h: num(k.highPrice),
      l: num(k.lowPrice),
      c: num(k.closePrice),
      v: big(k.volume),
    }));
  }
}
