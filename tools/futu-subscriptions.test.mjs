import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FutuHistory } from './futu-history.mjs';
import { StockSubscriptions } from './futu-subscriptions.mjs';
const require = createRequire(new URL('./futu-runtime/package.json', import.meta.url));
function fixture({ external = 0, failRelease = false } = {}) {
  const subscribed = new Set(); const operations = [];
  return { operations, sdk: {
    async GetSubInfo() { return { retType: 0, s2c: { totalUsedQuota: subscribed.size * 3 + external,
      remainQuota: 100 - subscribed.size * 3 - external } }; },
    async Sub({ c2s }) {
      const symbol = c2s.securityList[0].code;
      operations.push([symbol, c2s.isSubOrUnSub]);
      assert.deepEqual(c2s.subTypeList, [1, 2, 4]);
      if (!c2s.isSubOrUnSub && failRelease) return { retType: -1 };
      if (c2s.isSubOrUnSub) subscribed.add(symbol); else subscribed.delete(symbol);
      return { retType: 0 };
    },
  } };
}
test('QQQ/SPY stay pinned with quote, order book and ticker; no option types', async () => {
  const f = fixture(); const p = new StockSubscriptions(f.sdk);
  await p.update([]); await p.update([]);
  assert.deepEqual(f.operations, [['QQQ', true], ['SPY', true]]);
});
test('the 30-stock buffer excludes QQQ/SPY and consumes 96 slots at full capacity', async () => {
  const f = fixture(); const p = new StockSubscriptions(f.sdk);
  const result = await p.update(Array.from({ length: 30 }, (_, i) => `A${i}`));
  assert.equal(result.buffered.length, 32);
  assert.equal((await f.sdk.GetSubInfo()).s2c.remainQuota, 4);
});
test('LRU releases only inactive symbols after the one-minute minimum', async () => {
  const f = fixture(); let now = 0; const p = new StockSubscriptions(f.sdk, { capacity: 1, now: () => now });
  await p.update(['AAPL']); now = 59_999;
  await assert.rejects(p.update(['MSFT']), /quota_waiting_for_release/);
  assert.equal(f.operations.some(([s, sub]) => s === 'AAPL' && !sub), false);
  now = 60_000; await p.update(['MSFT']);
  assert.deepEqual(f.operations.slice(-2), [['AAPL', false], ['MSFT', true]]);
  assert.ok(p.entries.has('QQQ') && p.entries.has('SPY'));
});
test('capacity pressure never cancels active consumers', async () => {
  const f = fixture(); const p = new StockSubscriptions(f.sdk, { capacity: 1 });
  await p.update(['AAPL']); await assert.rejects(p.update(['AAPL', 'MSFT']), /stock_buffer_full/);
  assert.equal(f.operations.some(([, sub]) => !sub), false);
});
test('other OpenD connections consume real quota and cannot be unsubscribed', async () => {
  const f = fixture({ external: 94 }); const p = new StockSubscriptions(f.sdk);
  await p.update([]); await assert.rejects(p.update(['AAPL']), /quota_waiting_for_release/);
  assert.deepEqual(f.operations, [['QQQ', true], ['SPY', true]]);
});
test('failed unsubscribe ACK keeps the old allocation and rejects the replacement', async () => {
  const f = fixture({ failRelease: true }); let now = 0;
  const p = new StockSubscriptions(f.sdk, { capacity: 1, now: () => now });
  await p.update(['AAPL']); now = 60_001;
  await assert.rejects(p.update(['MSFT']), /futu_request_rejected/);
  assert.ok(p.entries.has('AAPL')); assert.ok(!p.entries.has('MSFT'));
});
test('invalid stock/option codes and oversized input do not reach the SDK', async () => {
  const f = fixture(); const p = new StockSubscriptions(f.sdk);
  await assert.rejects(p.update(['US.QQQ260101C100000']), /invalid_symbols/);
  await assert.rejects(p.update(['aapl']), /invalid_symbols/);
  await assert.rejects(p.update(Array(33).fill('AAPL')), /invalid_symbols/);
  assert.equal(f.operations.length, 0);
});
test('missing quota fields fail closed without subscribing', async () => {
  const f = fixture(); f.sdk.GetSubInfo = async () => ({ retType: 0, s2c: {} });
  const p = new StockSubscriptions(f.sdk);
  await assert.rejects(p.update([]), /quota_unknown/); assert.equal(f.operations.length, 0);
});

test('pinned Futu SDK exposes the official history method and required protocol enums', () => {
  const SDK = require('futu-api').default;
  const protoRoot = require('futu-api/proto');
  const session = protoRoot.lookupEnum('Common.Session').values;
  const klTypes = protoRoot.lookupEnum('Qot_Common.KLType').values;
  const rehab = protoRoot.lookupEnum('Qot_Common.RehabType').values;
  assert.equal(typeof SDK.prototype.RequestHistoryKL, 'function');
  assert.equal(session.Session_ALL, 3);
  assert.equal(klTypes.KLType_1Min, 1);
  assert.equal(klTypes.KLType_60Min, 9);
  assert.equal(rehab.RehabType_None, 0);
});

const HISTORY_ENUMS = {
  klTypes: { KLType_1Min: 1, KLType_Day: 2, KLType_Week: 3, KLType_Month: 4,
    KLType_5Min: 6, KLType_15Min: 7, KLType_60Min: 9 },
  klFields: { KLFields_High: 1, KLFields_Open: 2, KLFields_Low: 4,
    KLFields_Close: 8, KLFields_Volume: 32 },
  rehabTypeNone: 0,
  sessionAll: 3,
};
const baseRange = {
  symbol: 'aapl', timeframe: '1Min', limit: 2,
  start: '2026-01-05T14:00:00Z', end: '2026-01-05T15:00:00Z',
};
const bar = (time, overrides = {}) => ({
  time, isBlank: false, openPrice: 10.25, highPrice: 11.5,
  lowPrice: 9.75, closePrice: 10.5, volume: 1000, ...overrides,
});
function historyFixture({ pages, nowMs = Date.parse('2026-01-05T15:00:00Z'), wait = async () => {}, requestTimeoutMs } = {}) {
  const calls = [];
  let index = 0;
  const sdk = {
    async RequestHistoryKL({ c2s }) {
      calls.push({ ...c2s, security: { ...c2s.security },
        ...(c2s.nextReqKey ? { nextReqKey: Buffer.from(c2s.nextReqKey) } : {}) });
      if (pages) return pages[index++](c2s);
      return { retType: 0, s2c: { klList: [bar('2026-01-05 09:30:00')] } };
    },
  };
  return {
    calls,
    history: new FutuHistory(sdk, {
      ...HISTORY_ENUMS, now: () => typeof nowMs === 'function' ? nowMs() : nowMs, wait, requestTimeoutMs,
    }),
  };
}

test('history maps ET to UTC with the IANA timezone and records original event and receipt times', async () => {
  const f = historyFixture();
  const result = await f.history.bars(baseRange);
  assert.equal(f.calls[0].security.code, 'AAPL');
  assert.equal(f.calls[0].session, 3);
  assert.equal(result.bars[0].time, '2026-01-05T14:30:00.000Z');
  assert.equal(result.bars[0].event_time_et, '2026-01-05 09:30:00');
  assert.equal(result.bars[0].received_at, '2026-01-05T15:00:00.000Z');
  assert.equal(result.bars[0].open, '10.25');
  assert.equal(result.numeric_encoding, 'binary_float_projection');
  assert.equal(result.adjustment, 'none');
  assert.equal(result.source_entitlement, 'unknown');
  assert.equal(result.bars.length, 1);
});

test('history resolves daylight time using New York rules and excludes outside half-open UTC bounds', async () => {
  const f = historyFixture({ pages: [() => ({ retType: 0, s2c: { klList: [
    bar('2026-07-06 09:30:00'),
    bar('2026-07-06 10:30:00'),
    bar('2026-07-06 11:30:00'),
  ] } })] });
  const result = await f.history.bars({ ...baseRange,
    limit: 3, start: '2026-07-06T13:30:00Z', end: '2026-07-06T14:30:00Z' });
  assert.equal(result.bars.length, 1);
  assert.equal(result.bars[0].time, '2026-07-06T13:30:00.000Z');
});

test('ambiguous and nonexistent Eastern wall times reject the whole provider page', async () => {
  for (const time of ['2026-11-01 01:30:00', '2026-03-08 02:30:00']) {
    const f = historyFixture({ pages: [() => ({ retType: 0, s2c: { klList: [bar(time)] } })] });
    await assert.rejects(f.history.bars(baseRange), /UNSUPPORTED_PROVIDER_CAPABILITY/);
  }
});

test('daily bars use ET transaction dates and regular session without minute timestamp filtering', async () => {
  const f = historyFixture({ pages: [() => ({ retType: 0, s2c: { klList: [
    bar('2026-01-05 00:00:00'), bar('2026-01-06 00:00:00'), bar('2026-01-07 00:00:00'),
  ] } })] });
  const result = await f.history.bars({
    symbol: 'AAPL', timeframe: '1Day', limit: 3,
    start: '2026-01-05T05:00:00Z', end: '2026-01-07T05:00:00Z',
  });
  assert.equal('session' in f.calls[0], false);
  assert.deepEqual(result.bars.map(row => row.event_time_et.slice(0, 10)), ['2026-01-05', '2026-01-06']);
});

test('history accepts a terminal page decoded by the pinned SDK with no optional nextReqKey', async () => {
  const protoRoot = require('futu-api/proto');
  const Response = protoRoot.lookupType('Qot_RequestHistoryKL.Response');
  const missingVolume = bar('2026-01-05 09:31:00');
  delete missingVolume.volume;
  const decoded = Response.decode(Response.encode(Response.create({
    retType: 0,
    s2c: { security: { market: 11, code: 'AAPL' },
      klList: [bar('2026-01-05 09:30:00'), missingVolume] },
  })).finish());
  assert.equal(Object.hasOwn(decoded.s2c, 'nextReqKey'), false);
  assert.equal(Object.hasOwn(decoded.s2c.klList[1], 'volume'), false);
  const f = historyFixture({ pages: [() => decoded] });
  const result = await f.history.bars(baseRange);
  assert.equal(result.bars.length, 2);
  assert.equal(result.bars[0].volume, '1000');
  assert.equal(result.bars[1].volume, null);
  assert.equal(result.has_more, false);
  assert.equal(result.cursor, null);
  assert.equal(result.truncated, false);
});

test('history rejects malformed explicit nextReqKey values instead of treating them as absent', async () => {
  for (const nextReqKey of [[], [1], 'invalid-key', { length: 0 }]) {
    const f = historyFixture({ pages: [() => ({ retType: 0, s2c: {
      klList: [bar('2026-01-05 09:30:00')], nextReqKey,
    } })] });
    await assert.rejects(f.history.bars(baseRange), /futu_invalid_response/);
  }
});

test('history cursor is opaque, query-bound, and forwards the exact SDK nextReqKey bytes', async () => {
  const sdkKey = Buffer.from([0, 255, 16, 128]);
  const f = historyFixture({ pages: [
    () => ({ retType: 0, s2c: { klList: [bar('2026-01-05 09:30:00')], nextReqKey: sdkKey } }),
    () => ({ retType: 0, s2c: { klList: [bar('2026-01-05 09:31:00')] } }),
  ] });
  await assert.rejects(f.history.bars({ ...baseRange, cursor: '' }), /invalid_cursor/);
  assert.equal(f.calls.length, 0);
  const first = await f.history.bars(baseRange);
  assert.equal(first.has_more, true);
  assert.equal(first.truncated, false);
  assert.match(first.cursor, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.cursor, sdkKey.toString('base64url'));
  await assert.rejects(f.history.bars({ ...baseRange, start: '2026-01-05T13:00:00Z', cursor: first.cursor }),
    /cursor_query_mismatch/);
  const second = await f.history.bars({ ...baseRange, cursor: first.cursor });
  assert.deepEqual(f.calls[1].nextReqKey, sdkKey);
  assert.equal(second.pages_fetched, 2);
  assert.equal(second.has_more, false);
  await assert.rejects(f.history.bars({ ...baseRange, cursor: first.cursor }), /invalid_cursor/);
});

test('history cursor expires after its bounded lifetime', async () => {
  let now = Date.parse('2026-01-05T15:00:00Z');
  const f = historyFixture({
    nowMs: () => now,
    pages: [() => ({ retType: 0, s2c: { klList: [], nextReqKey: Buffer.from([1]) } })],
  });
  const first = await f.history.bars(baseRange);
  now += 30 * 60 * 1000 + 1;
  await assert.rejects(f.history.bars({ ...baseRange, cursor: first.cursor }), /invalid_cursor/);
  assert.equal(f.calls.length, 1);
});

test('history cursor pages are capped and expose truncation without leaking the provider key', async () => {
  const f = historyFixture({ pages: Array.from({ length: 20 }, (_, page) => () => ({
    retType: 0,
    s2c: { klList: [], nextReqKey: Buffer.from([page + 1]) },
  })) });
  let request = baseRange;
  let result;
  for (let page = 0; page < 20; page++) {
    result = await f.history.bars(request);
    if (result.cursor) request = { ...baseRange, cursor: result.cursor };
  }
  assert.equal(result.pages_fetched, 20);
  assert.equal(result.has_more, true);
  assert.equal(result.cursor, null);
  assert.equal(result.truncated, true);
  assert.equal(f.calls.length, 20);
});

test('history preserves missing volume and exact int64 text without claiming exact SDK prices', async () => {
  const f = historyFixture({ pages: [() => ({ retType: 0, s2c: { klList: [
    bar('2026-01-05 09:30:00', { volume: { toString: () => '9007199254740993' } }),
    bar('2026-01-05 09:31:00', { volume: null }),
  ] } })] });
  const result = await f.history.bars(baseRange);
  assert.equal(result.bars[0].volume, '9007199254740993');
  assert.equal(result.bars[1].volume, null);
  assert.equal(result.bars[0].close, '10.5');
  assert.equal(result.numeric_encoding, 'binary_float_projection');
});

test('binary float prices expand exponent notation without rounding and stay within Core decimal bounds', async () => {
  const f = historyFixture({ pages: [() => ({ retType: 0, s2c: { klList: [bar(
    '2026-01-05 09:30:00',
    { openPrice: 1e-7, highPrice: 1e21, lowPrice: 1e-28, closePrice: 1e38 },
  )] } })] });
  const result = await f.history.bars(baseRange);
  assert.deepEqual(
    [result.bars[0].open, result.bars[0].high, result.bars[0].low, result.bars[0].close],
    ['0.0000001', '1000000000000000000000', '0.0000000000000000000000000001',
      '100000000000000000000000000000000000000'],
  );
  assert.equal(result.numeric_encoding, 'binary_float_projection');

  for (const unsupported of [1e-29, 1e39, 1e100]) {
    const rejected = historyFixture({ pages: [() => ({ retType: 0, s2c: { klList: [
      bar('2026-01-05 09:30:00', { openPrice: unsupported }),
    ] } })] });
    await assert.rejects(rejected.history.bars(baseRange), /UNSUPPORTED_PROVIDER_CAPABILITY/);
  }
});

test('history request timeout recovers on the next SDK request and provider errors stay sanitized', async () => {
  let calls = 0;
  const f = historyFixture({ requestTimeoutMs: 5, pages: [
    () => { calls++; return new Promise(() => {}); },
    () => { calls++; return { retType: 0, s2c: { klList: [bar('2026-01-05 09:30:00')] } }; },
  ] });
  await assert.rejects(f.history.bars(baseRange), /futu_timeout/);
  assert.equal((await f.history.bars(baseRange)).bars.length, 1);
  assert.equal(calls, 2);

  const denied = historyFixture({ pages: [() => Promise.reject({ retMsg: 'permission denied' })] });
  await assert.rejects(denied.history.bars(baseRange), /futu_history_permission_denied/);

  const malformed = historyFixture({ pages: [() => ({ retType: 0, s2c: {
    klList: [bar('2026-01-05 09:30:00', { openPrice: 0 })],
  } })] });
  await assert.rejects(malformed.history.bars(baseRange), /futu_invalid_response/);
});

test('history request interval is bounded and unsupported timeframes never reach OpenD', async () => {
  const waits = [];
  const f = historyFixture({ wait: async ms => waits.push(ms) });
  await f.history.bars(baseRange);
  await f.history.bars(baseRange);
  assert.deepEqual(waits, [500]);
  const count = f.calls.length;
  await assert.rejects(f.history.bars({ ...baseRange, timeframe: '3Min' }), /UNSUPPORTED_PROVIDER_CAPABILITY/);
  assert.equal(f.calls.length, count);
});
