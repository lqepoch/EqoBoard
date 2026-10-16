// Configuration comes from process.env only. The root .env is loaded by Node at start-up
// (`node --env-file-if-exists=../../.env src/server.mjs`, see apps/desk/AGENTS.md), so the
// application never reads a file itself and no file data reaches an outbound request.

// Alpaca's own trading hosts only; a bad environment value cannot send the keys anywhere else.
const ALPACA_TRADING_BASES = new Set(['https://paper-api.alpaca.markets', 'https://api.alpaca.markets']);

export function loadConfig(env = process.env) {
  const port = Number(env.DESK_PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('DESK_PORT invalid');
  const futuHost = env.FUTU_OPEND_HOST ?? '127.0.0.1';
  if (futuHost !== '127.0.0.1' && futuHost !== 'localhost') throw new Error('FUTU_OPEND_HOST must be loopback');
  const tradingBase = env.APCA_API_BASE_URL ?? 'https://paper-api.alpaca.markets';
  if (!ALPACA_TRADING_BASES.has(tradingBase)) throw new Error('APCA_API_BASE_URL must be an Alpaca trading host');
  return {
    port,
    futu: {
      host: futuHost,
      port: Number(env.FUTU_OPEND_WEBSOCKET_PORT ?? 12345),
      ssl: env.FUTU_OPEND_WEBSOCKET_SSL === 'true',
      key: env.FUTU_OPEND_WEBSOCKET_KEY ?? '',
    },
    alpaca: {
      key: env.ALPACA_KEY ?? '',
      secret: env.ALPACA_SECRET ?? '',
      tradingBase,
      dataBase: 'https://data.alpaca.markets',
      feed: 'indicative',
    },
  };
}
