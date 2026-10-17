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

function linkFeed() {
  const sdk = {
    websock: {},
    startCalls: 0,
    start() {
      this.startCalls += 1;
    },
    stop() {},
    Sub: async () => ({ retType: 0 }),
    GetSubInfo: async () => ({ retType: 0, s2c: { totalUsedQuota: 0, remainQuota: 100 } }),
  };
  const feed = new FutuFeed({ host: '127.0.0.1', port: 12345, ssl: false, key: '', log: () => {}, sdk });
  return { feed, sdk };
}

test('connection state moves from connecting to reconnecting to connected, with the reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, sdk } = linkFeed();
  feed.start();
  assert.equal(feed.status().state, 'connecting');
  sdk.websock.onerror();
  sdk.websock.onclose();
  let status = feed.status();
  assert.equal(status.state, 'reconnecting');
  assert.equal(status.attempts, 0);
  assert.match(status.reason, /127\.0\.0\.1:12345/);
  t.mock.timers.tick(2_000);
  assert.equal(sdk.startCalls, 2, 'the watchdog re-dials after the first backoff');
  assert.equal(feed.status().attempts, 1);
  sdk.onlogin(true);
  status = feed.status();
  assert.equal(status.state, 'connected');
  assert.equal(status.attempts, 0);
  assert.equal(status.reason, null);
  t.mock.timers.tick(60_000);
  assert.equal(sdk.startCalls, 2, 'no re-dial once connected');
});

test('the re-dial backoff doubles and is capped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, sdk } = linkFeed();
  feed.start();
  const waits = [];
  for (let i = 0; i < 6; i += 1) {
    const before = sdk.startCalls;
    let elapsed = 0;
    while (sdk.startCalls === before && elapsed < 60_000) {
      t.mock.timers.tick(1_000);
      elapsed += 1_000;
    }
    waits.push(elapsed);
  }
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  feed.stop();
});

test('a drop after login is re-dialled by the watchdog as well', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, sdk } = linkFeed();
  feed.start();
  sdk.onlogin(true);
  sdk.websock.onclose();
  assert.equal(feed.status().state, 'reconnecting');
  assert.equal(feed.status().connected, false);
  t.mock.timers.tick(2_000);
  assert.equal(sdk.startCalls, 2);
  feed.stop();
});

test('a rejected login is not overwritten by the close that follows it', () => {
  const { feed, sdk } = linkFeed();
  feed.start();
  sdk.onlogin(false, 'bad key');
  sdk.websock.onclose();
  const status = feed.status();
  assert.equal(status.state, 'login_rejected');
  assert.match(status.reason, /密钥/);
  assert.equal(status.connected, false);
});

test('status exposes the endpoint but never the websocket key', () => {
  const sdk = { websock: {}, start() {}, Sub: async () => ({}), GetSubInfo: async () => ({}) };
  const feed = new FutuFeed({ host: '127.0.0.1', port: 12345, ssl: false, key: 'secret-key', log: () => {}, sdk });
  assert.equal(JSON.stringify(feed.status()).includes('secret-key'), false);
  assert.equal(feed.status().endpoint, '127.0.0.1:12345');
});
