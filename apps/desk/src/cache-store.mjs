// On-disk copy of the tick cache. Written atomically (temp file, then rename) and read on startup.
// The file holds only aggregated bars (no raw trades), so it stays small.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function loadCacheFile(cache, file, nowS = Math.floor(Date.now() / 1000)) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return 0; // No file yet, or unreadable: start empty.
  }
  let symbols = 0;
  for (const [symbol, frames] of Object.entries(data.symbols ?? {})) {
    if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol)) continue;
    cache.restore(symbol, frames, nowS);
    symbols += 1;
  }
  return symbols;
}

export function saveCacheFile(cache, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), symbols: cache.snapshot() }));
  renameSync(tmp, file);
}
