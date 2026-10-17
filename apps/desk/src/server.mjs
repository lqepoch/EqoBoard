import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { FutuFeed, PINNED, IDLE_CHECK_MS } from './futu.mjs';
import { AlpacaOptions } from './alpaca.mjs';
import { quoteHeader } from './yahoo.mjs';
import { loadBars, TIMEFRAMES } from './bars.mjs';
import { TickCache } from './cache.mjs';
import { loadCacheFile, saveCacheFile } from './cache-store.mjs';
import { AlpacaBars } from './alpaca-bars.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const VENDOR = path.join(HERE, '..', 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js');
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const log = (...args) => process.stdout.write(`[desk] ${args.join(' ')}\n`);
// The futu-api SDK logs raw protocol responses; keep them out of the console.
console.debug = console.log = console.warn = console.error = () => {};

const cfg = loadConfig();
const futu = new FutuFeed({ ...cfg.futu, log });
const alpaca = new AlpacaOptions(cfg.alpaca);
// Stock bars use the IEX feed; the options chain uses the indicative feed (different endpoints).
const alpacaBars = new AlpacaBars({ ...cfg.alpaca, feed: 'iex' });
const cache = new TickCache();
const ctx = { alpaca: alpacaBars, cache };
// Local copy of the aggregated bars: survives page reloads and server restarts (apps/desk/data is git-ignored).
const CACHE_FILE = path.join(HERE, '..', 'data', 'tick-cache.json');
const restored = loadCacheFile(cache, CACHE_FILE);
log(`restored tick cache for ${restored} symbol(s)`);
const persist = () => {
  try {
    saveCacheFile(cache, CACHE_FILE);
  } catch {
    log('tick cache save failed');
  }
};
setInterval(persist, 30_000).unref();
const ALLOWED_HOSTS = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);

futu.on('status', (s) => log('futu', s.state, s.attempts ? `attempt ${s.attempts}` : '', s.reason ?? ''));
futu.on('trade', (t) => cache.add(t.symbol, t));
futu.start();
// Releases subscriptions that nobody has asked for lately (see FutuFeed.releaseIdle).
setInterval(() => {
  futu.releaseIdle().then(
    (symbols) => {
      if (symbols.length) log('released idle subscriptions', symbols.join(','));
    },
    (err) => log('idle release failed', err.message),
  );
}, IDLE_CHECK_MS).unref();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  res.end(payload);
}

const fail = (res, status, code) => send(res, status, { error: code });

function symbolList(raw, max) {
  const parts = String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!parts.length || parts.length > max || parts.some((s) => !SYMBOL.test(s))) return null;
  return [...new Set(parts)];
}

const UPSTREAM_CODES = new Set([
  'futu_disconnected', 'futu_read_failed', 'futu_request_rejected', 'quota_unavailable', 'stock_buffer_full',
  'unsupported_timeframe',
]);

function mapError(err) {
  const code = String(err?.message ?? '');
  if (code === 'futu_disconnected') return [503, code];
  if (code === 'unsupported_timeframe') return [400, code];
  if (code === 'stock_buffer_full' || code === 'quota_unavailable') return [429, code];
  if (code.startsWith('alpaca_http_')) return [502, 'alpaca_unavailable'];
  if (UPSTREAM_CODES.has(code)) return [502, code];
  return [502, 'upstream_failed'];
}

async function quoteRoute(res, url) {
  const list = symbolList(url.searchParams.get('symbols'), 32);
  if (!list) return fail(res, 400, 'invalid_symbols');
  // Futu only returns basic quotes for symbols on the subscription list, so subscribe first.
  await futu.watch(list);
  const quotes = await futu.snapshot(list);
  const wantHeader = url.searchParams.get('header') === '1' && list.length === 1;
  let header = null;
  let headerError = null;
  if (wantHeader) {
    try {
      header = await quoteHeader(list[0]);
    } catch {
      headerError = 'yfinance_unavailable';
    }
  }
  return send(res, 200, { quotes, header, headerError, headerSource: wantHeader ? 'yfinance' : null });
}

async function barsRoute(res, url) {
  const symbol = symbolList(url.searchParams.get('symbol'), 1)?.[0];
  const tf = url.searchParams.get('tf');
  if (!symbol) return fail(res, 400, 'invalid_symbol');
  if (!TIMEFRAMES.includes(tf)) return fail(res, 400, 'unsupported_timeframe');
  const seconds = tf.endsWith('s');
  const max = seconds ? 3600 : 1500;
  const requested = Number(url.searchParams.get('limit') ?? (seconds ? 600 : 1000));
  const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), max) : 600;
  // 1m works without Alpaca: it then shows only the local Futu window (see bars.mjs).
  if (!seconds && tf !== '1m' && !alpacaBars.configured) return fail(res, 503, 'alpaca_unconfigured');
  const value = await loadBars(ctx, symbol, tf, limit);
  // asOfSeq: trades with a higher Futu sequence arrived after this response was built and must be applied client-side.
  return send(res, 200, {
    symbol,
    tf,
    source: value.source,
    localOnly: value.localOnly === true,
    adjustment: 'raw',
    asOfSeq: futu.seq,
    bars: value.bars,
  });
}

function streamRoute(req, res, url) {
  const list = symbolList(url.searchParams.get('symbols'), 8);
  if (!list) return fail(res, 400, 'invalid_symbols');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const wanted = new Set(list);
  // An open stream keeps its symbols subscribed until the client disconnects.
  const release = futu.hold(list);
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onTrade = (t) => wanted.has(t.symbol) && write('trade', t);
  const onDepth = (d) => wanted.has(d.symbol) && write('depth', d);
  const onQuote = (q) => wanted.has(q.symbol) && write('quote', q);
  const onStatus = (s) => write('status', s);
  futu.on('trade', onTrade);
  futu.on('depth', onDepth);
  futu.on('quote', onQuote);
  futu.on('status', onStatus);
  for (const s of list) {
    write('history', {
      symbol: s,
      trades: (futu.trades.get(s) ?? []).slice(-120),
      depth: futu.depth.get(s) ?? null,
      quote: futu.quotes.get(s) ?? null,
    });
  }
  futu.watch(list).then(
    (subscribed) => write('subscribed', { subscribed }),
    (err) => write('fault', { code: mapError(err)[1] }),
  );
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    futu.off('trade', onTrade);
    futu.off('depth', onDepth);
    futu.off('quote', onQuote);
    futu.off('status', onStatus);
    release();
  });
}

async function expiriesRoute(res, url) {
  const underlying = symbolList(url.searchParams.get('underlying'), 1)?.[0];
  if (!underlying) return fail(res, 400, 'invalid_underlying');
  if (!alpaca.configured) return fail(res, 503, 'alpaca_unconfigured');
  const expiries = await alpaca.expiries(underlying);
  return send(res, 200, { underlying, expiries, feed: cfg.alpaca.feed });
}

async function chainRoute(res, url) {
  const underlying = symbolList(url.searchParams.get('underlying'), 1)?.[0];
  const expiry = url.searchParams.get('expiry');
  if (!underlying) return fail(res, 400, 'invalid_underlying');
  if (!DATE.test(expiry ?? '')) return fail(res, 400, 'invalid_expiry');
  if (!alpaca.configured) return fail(res, 503, 'alpaca_unconfigured');
  let spot = null;
  if (futu.connected) {
    try {
      spot = (await futu.snapshot([underlying]))[0]?.last ?? null;
    } catch {
      spot = null;
    }
  }
  const chain = await alpaca.chain(underlying, expiry, spot);
  return send(res, 200, { ...chain, spot, spotSource: spot === null ? null : 'Futu OpenD' });
}

async function route(req, res, url) {
  if (req.method === 'GET' && STATIC.has(url.pathname)) {
    const [file, type] = STATIC.get(url.pathname);
    return send(res, 200, readFileSync(path.join(PUBLIC, file)), type);
  }
  if (req.method === 'GET' && url.pathname === '/vendor/lightweight-charts.js') {
    return send(res, 200, readFileSync(VENDOR), 'text/javascript; charset=utf-8');
  }
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  switch (url.pathname) {
    case '/api/status':
      return send(res, 200, {
        futu: futu.status(),
        cache: cache.stats(),
        alpaca: { configured: alpaca.configured, feed: cfg.alpaca.feed },
        alpacaBars: { configured: alpacaBars.configured, feed: 'iex' },
        timeframes: TIMEFRAMES,
        pinned: PINNED,
        now: new Date().toISOString(),
      });
    case '/api/quote':
      return quoteRoute(res, url);
    case '/api/bars':
      return barsRoute(res, url);
    case '/api/stream':
      return streamRoute(req, res, url);
    case '/api/options/expiries':
      return expiriesRoute(res, url);
    case '/api/options/chain':
      return chainRoute(res, url);
    default:
      return fail(res, 404, 'not_found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return fail(res, 403, 'host_not_allowed');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
    await route(req, res, url);
  } catch (err) {
    if (!res.headersSent) {
      const [status, code] = mapError(err);
      fail(res, status, code);
    } else {
      res.end();
    }
  }
});

server.listen(cfg.port, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${cfg.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    persist();
    futu.stop();
    server.close(() => process.exit(0));
  });
}
