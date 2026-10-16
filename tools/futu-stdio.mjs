// Local-only, read-only official-SDK transport. Rust owns HTTP authentication and browser SSE.
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { FutuHistory } from './futu-history.mjs';
import { StockSubscriptions } from './futu-subscriptions.mjs';
const require = createRequire(new URL('./futu-runtime/package.json', import.meta.url));
const SDK = require('futu-api').default;
const { ftCmdID } = require('futu-api');
const protoRoot = require('futu-api/proto');
console.debug = console.log = console.warn = console.error = () => {}; // SDK logs may contain raw responses.
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
const host = process.env.FUTU_OPEND_HOST ?? '127.0.0.1';
const port = Number(process.env.FUTU_OPEND_WEBSOCKET_PORT ?? 33333);
if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('Futu transport requires configured loopback endpoint');
}
const sdk = new SDK();
const policy = new StockSubscriptions(sdk);
const history = new FutuHistory(sdk, {
  klTypes: protoRoot.lookupEnum('Qot_Common.KLType').values,
  klFields: protoRoot.lookupEnum('Qot_Common.KLFields').values,
  rehabTypeNone: protoRoot.lookupEnum('Qot_Common.RehabType').values.RehabType_None,
  sessionAll: protoRoot.lookupEnum('Common.Session').values.Session_ALL,
});
let connected = false;
let connectionError = 'futu_disconnected';
const finite = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const volume = v => { const n = Number(v?.toString()); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
const timestamp = v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e11
  ? new Date(v * 1000).toISOString() : null;
sdk.onlogin = ok => {
  connected = Boolean(ok); policy.entries.clear(); history.connectionChanged(connected);
  connectionError = connected ? null : 'futu_login_rejected';
  emit({ kind: 'connection', connected, ...(connected ? {} : { error: connectionError }) });
};
sdk.onPush = (cmd, response) => {
  if (!connected || response.retType !== 0 || !response.s2c) return;
  const data = response.s2c;
  if (cmd === ftCmdID.QotUpdateBasicQot.cmd) {
    for (const q of data.basicQotList ?? []) {
      if (q.security?.market !== 11 || !policy.entries.has(q.security.code)) continue;
      // Basic quote snapshots are read through GetBasicQot; no unbounded parallel cache.
    }
  } else if (cmd === ftCmdID.QotUpdateTicker.cmd && data.security?.market === 11 && policy.entries.has(data.security.code)) {
    for (const t of data.tickerList ?? []) {
      const price = finite(t.price), size = volume(t.volume), time = timestamp(t.timestamp);
      if (price === null || price <= 0 || size === null || !time || t.pushDataType !== 1) continue;
      emit({ kind: 'stock_trade', symbol: data.security.code, price, size, timestamp: time });
    }
  } else if (cmd === ftCmdID.QotUpdateOrderBook.cmd && data.security?.market === 11 && policy.entries.has(data.security.code)) {
    // OpenD order book has no independently verified event time; never manufacture one.
    emit({ kind: 'stock_quote', symbol: data.security.code,
      bid: finite(data.orderBookBidList?.[0]?.price), ask: finite(data.orderBookAskList?.[0]?.price), timestamp: null });
  }
};
async function call(name, c2s) {
  const response = await sdk[name]({ c2s }); policy.check(response); if (!response.s2c) throw new Error('futu_read_failed'); return response.s2c;
}
async function dispatch(request) {
  if (!connected) throw new Error(connectionError ?? 'futu_disconnected');
  if (request.method === 'subscriptions') return policy.update(request.symbols);
  if (request.method === 'status') {
    const q = await call('GetSubInfo', { isReqAllConn: true });
    return { connected, stock_used: q.totalUsedQuota, stock_remaining: q.remainQuota,
      buffered: [...policy.entries.keys()], options_enabled: false };
  }
  if (request.method === 'snapshots') {
    const symbols = request.symbols;
    if (!Array.isArray(symbols) || symbols.length > 32 || symbols.some(s => !policy.entries.has(s))) {
      throw new Error('subscription_required');
    }
    const q = await call('GetBasicQot', { securityList: symbols.map(code => ({ market: 11, code })) });
    return { feed: 'futu', source_mode: 'futu', source_label: 'Futu OpenD', source_entitlement: 'unknown',
      snapshots: q.basicQotList.map(row => ({
        symbol: row.security.code, last: finite(row.curPrice), previous_close: finite(row.lastClosePrice),
        change_percent: finite(row.lastClosePrice) > 0 ? (row.curPrice / row.lastClosePrice - 1) * 100 : null,
        open: finite(row.openPrice), high: finite(row.highPrice), low: finite(row.lowPrice),
        bid: null, ask: null, volume: volume(row.volume), feed: 'futu',
        last_as_of: timestamp(row.updateTimestamp), last_basis: 'unknown', quote_at: null, trade_at: null,
        received_at: new Date().toISOString(), source_mode: 'futu', source_label: 'Futu OpenD',
      })) };
  }
  if (request.method === 'bars') return history.bars(request);
  throw new Error('unsupported_read_operation');
}
// Serialize requests, quota observations and all subscription mutations.
let queue = Promise.resolve(); let pending = 0;
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  if (line.length > 16_384) return;
  let request; try { request = JSON.parse(line); } catch { return; }
  if (!Number.isSafeInteger(request.id) || request.id < 1) return;
  if (++pending > 64) { --pending; emit({ id: request.id, error: 'futu_queue_full' }); return; }
  queue = queue.then(async () => {
    try { emit({ id: request.id, result: await dispatch(request) }); }
    catch (e) {
      const allowed = ['quota_waiting_for_release', 'quota_unknown', 'stock_buffer_full', 'invalid_symbols',
        'futu_request_rejected', 'subscription_required', 'futu_disconnected', 'futu_login_rejected', 'futu_queue_full',
        'UNSUPPORTED_PROVIDER_CAPABILITY', 'invalid_bars_query', 'invalid_limit', 'invalid_days',
        'invalid_start', 'invalid_end', 'invalid_cursor', 'cursor_query_mismatch', 'futu_timeout',
        'futu_rate_limited', 'futu_history_permission_denied', 'futu_invalid_response', 'futu_read_failed'];
      emit({ id: request.id, error: allowed.includes(e?.message) ? e.message : 'futu_read_failed' });
    } finally { --pending; }
  });
});
input.on('close', () => { sdk.stop(); process.exit(0); });
process.on('SIGTERM', () => { sdk.stop(); process.exit(0); });
sdk.start(host, port, process.env.FUTU_OPEND_WEBSOCKET_SSL === 'true', process.env.FUTU_OPEND_WEBSOCKET_KEY);
