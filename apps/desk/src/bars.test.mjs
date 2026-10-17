import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBars } from './bars.mjs';

const NOW = Date.UTC(2026, 9, 17, 15, 0, 0);
const local = [
  { t: 1_781_000_000, o: 1, h: 2, l: 1, c: 2, v: 10, n: 1 },
  { t: 1_781_000_060, o: 2, h: 3, l: 2, c: 3, v: 20, n: 1 },
];

function ctx({ configured, history = null }) {
  return {
    alpaca: {
      configured,
      history: async () => {
        if (!history) throw new Error('history must not be requested');
        return history;
      },
    },
    cache: { bars: () => local },
  };
}

test('1m without Alpaca shows only the local Futu window and says so', async () => {
  const value = await loadBars(ctx({ configured: false }), 'TSLA', '1m', 100, NOW);
  assert.equal(value.localOnly, true);
  assert.deepEqual(value.bars, local);
  assert.match(value.source, /仅最近 20 分钟/);
});

test('1m with Alpaca keeps the history and the local window together', async () => {
  const older = [{ t: 1_780_000_000, o: 0, h: 1, l: 0, c: 1, v: 5, n: null }];
  const value = await loadBars(ctx({ configured: true, history: older }), 'TSLA', '1m', 100, NOW);
  assert.equal(value.localOnly, false);
  assert.deepEqual(value.bars, [...older, ...local]);
});

test('5m still needs Alpaca history and does not use the local window', async () => {
  const bars = [{ t: 1_780_000_000, o: 0, h: 1, l: 0, c: 1, v: 5, n: null }];
  const value = await loadBars(ctx({ configured: true, history: bars }), 'TSLA', '5m', 100, NOW);
  assert.deepEqual(value.bars, bars);
  assert.equal(value.localOnly, undefined);
});
