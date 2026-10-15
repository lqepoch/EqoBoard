type Entry<Value> = Readonly<{ value: Value; expiresAt: number }>;
type Pending<Value> = Promise<Value>;

const MAX_ENTRIES = 256;
const values = new Map<string, Entry<unknown>>();
const pending = new Map<string, Pending<unknown>>();

export type CacheResult<Value> = Readonly<{ value: Value; cache: "miss" | "hit" }>;

/** Bounded per-process TTL cache with request coalescing; no cross-instance guarantee. */
export async function getCached<Value>(
  key: string,
  ttlMs: number,
  load: () => Promise<Value>,
  now = Date.now(),
): Promise<CacheResult<Value>> {
  if (key.length > 256 || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60_000) {
    throw new TypeError("invalid-research-cache-request");
  }
  const hit = values.get(key) as Entry<Value> | undefined;
  if (hit && hit.expiresAt > now) {
    values.delete(key);
    values.set(key, hit);
    return { value: hit.value, cache: "hit" };
  }
  if (hit) values.delete(key);
  const existing = pending.get(key) as Pending<Value> | undefined;
  if (existing) return { value: await existing, cache: "hit" };

  const work = load();
  pending.set(key, work);
  try {
    const value = await work;
    values.delete(key);
    values.set(key, { value, expiresAt: now + ttlMs });
    while (values.size > MAX_ENTRIES) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) break;
      values.delete(oldest);
    }
    return { value, cache: "miss" };
  } finally {
    if (pending.get(key) === work) pending.delete(key);
  }
}

export function clearResearchCacheForTests(): void {
  values.clear();
  pending.clear();
}

export function researchCacheSizeForTests(): number {
  return values.size;
}
