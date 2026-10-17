import test from 'node:test';
import assert from 'node:assert/strict';
import { FutuFeed } from './futu.mjs';

// Fake OpenD SDK: records each Sub request. Nothing here touches the network.
function fakeFeed({ rejectUnsubscribe = false } = {}) {
  const calls = [];
  const sdk = {
    Sub: async (req) => {
      calls.push(req.c2s);
      if (rejectUnsubscribe && !req.c2s.isSubOrUnSub) return { retType: -1 };
      return { retType: 0 };
    },
    GetSubInfo: async () => ({ retType: 0, s2c: { totalUsedQuota: 0, remainQuota: 100 } }),
  };
  const feed = new FutuFeed({ host: '127.0.0.1', port: 1, ssl: false, key: '', log: () => {}, sdk });
  feed.connected = true;
  return { feed, calls };
}

const MIN = 60_000;
const subscribed = (feed) => [...feed.subs.keys()].sort();

test('pinned QQQ and SPY are never released', async () => {
  const { feed } = fakeFeed();
  await feed.watch([]);
  const t0 = Date.now();
  assert.deepEqual(await feed.releaseIdle(t0 + 24 * 60 * MIN), []);
  assert.deepEqual(subscribed(feed), ['QQQ', 'SPY']);
});

test('an idle symbol is unsubscribed with both subscribe and push registration off', async () => {
  const { feed, calls } = fakeFeed();
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  assert.deepEqual(await feed.releaseIdle(t0 + 4 * MIN), ['AAPL']);
  assert.deepEqual(subscribed(feed), ['QQQ', 'SPY']);
  const last = calls.at(-1);
  assert.equal(last.isSubOrUnSub, false);
  assert.equal(last.isRegOrUnRegPush, false);
  assert.deepEqual(last.securityList, [{ market: 11, code: 'AAPL' }]);
});

test('a symbol asked for within the idle window stays subscribed', async () => {
  const { feed } = fakeFeed();
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  assert.deepEqual(await feed.releaseIdle(t0 + 2 * MIN), []);
  assert.ok(subscribed(feed).includes('AAPL'));
});

test('open trade streams hold their symbols, counted per stream', async () => {
  const { feed } = fakeFeed();
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  const first = feed.hold(['AAPL']);
  const second = feed.hold(['AAPL']);
  first();
  assert.deepEqual(await feed.releaseIdle(t0 + 10 * MIN), [], 'one stream still open');
  second();
  second();
  assert.deepEqual(await feed.releaseIdle(t0 + 10 * MIN), ['AAPL'], 'released once the last stream closed');
});

test('a symbol subscribed less than a minute ago is kept even when idle', async () => {
  const { feed } = fakeFeed();
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  feed.lastAsked.set('AAPL', 0);
  feed.subs.get('AAPL').since = t0;
  assert.deepEqual(await feed.releaseIdle(t0 + 30_000), []);
});

test('a rejected unsubscribe keeps the symbol subscribed for the next sweep', async () => {
  const { feed } = fakeFeed({ rejectUnsubscribe: true });
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  assert.deepEqual(await feed.releaseIdle(t0 + 4 * MIN), []);
  assert.ok(subscribed(feed).includes('AAPL'));
});

test('a stream that opens while the cancel is in flight gets its subscription back', async () => {
  const calls = [];
  const sdk = {
    Sub: async (req) => {
      calls.push(req.c2s);
      // A trade stream opens for AAPL during the cancel; the feed has already decided to release it.
      if (!req.c2s.isSubOrUnSub) feed.hold(['AAPL']);
      return { retType: 0 };
    },
    GetSubInfo: async () => ({ retType: 0, s2c: { totalUsedQuota: 0, remainQuota: 100 } }),
  };
  const feed = new FutuFeed({ host: '127.0.0.1', port: 1, ssl: false, key: '', log: () => {}, sdk });
  feed.connected = true;
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  assert.deepEqual(await feed.releaseIdle(t0 + 4 * MIN), []);
  assert.ok(subscribed(feed).includes('AAPL'));
  assert.equal(calls.at(-1).isSubOrUnSub, true, 'subscription restored after the cancel');
});

test('nothing is released while OpenD is disconnected', async () => {
  const { feed } = fakeFeed();
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  feed.connected = false;
  assert.deepEqual(await feed.releaseIdle(t0 + 4 * MIN), []);
});

test('a released symbol subscribes again when it is asked for', async () => {
  const { feed, calls } = fakeFeed();
  const t0 = Date.now();
  await feed.watch(['AAPL']);
  await feed.releaseIdle(t0 + 4 * MIN);
  await feed.watch(['AAPL']);
  assert.ok(subscribed(feed).includes('AAPL'));
  assert.equal(calls.at(-1).isSubOrUnSub, true);
});
