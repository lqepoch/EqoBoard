import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StockSubscriptions } from './futu-subscriptions.mjs';
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
