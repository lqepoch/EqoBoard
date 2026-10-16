import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');

/** Reads KEY=VALUE lines from the repo-root .env. Values stay inside this process. */
export function readDotEnv(file = path.join(REPO_ROOT, '.env')) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function loadConfig(env = readDotEnv()) {
  const port = Number(process.env.DESK_PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('DESK_PORT invalid');
  const futuHost = env.FUTU_OPEND_HOST ?? '127.0.0.1';
  if (futuHost !== '127.0.0.1' && futuHost !== 'localhost') throw new Error('FUTU_OPEND_HOST must be loopback');
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
      tradingBase: env.APCA_API_BASE_URL ?? 'https://paper-api.alpaca.markets',
      dataBase: 'https://data.alpaca.markets',
      feed: 'indicative',
    },
  };
}
