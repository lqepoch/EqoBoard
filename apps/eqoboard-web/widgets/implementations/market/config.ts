const CONTROL = /[\u0000-\u001f\u007f]/u;

export type EmptyMarketConfigV1 = Readonly<{ schemaVersion: 1 }>;
export type OptionExpiryConfigV1 = Readonly<{ schemaVersion: 1; expiry: string }>;

export const EMPTY_MARKET_CONFIG: EmptyMarketConfigV1 = Object.freeze({ schemaVersion: 1 });

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !descriptors[key] ||
        !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseEmptyMarketConfig(value: unknown):
  | Readonly<{ ok: true; value: EmptyMarketConfigV1 }>
  | Readonly<{ ok: false; code: "config-invalid" }> {
  const row = plainRecord(value);
  if (!row || Reflect.ownKeys(row).length !== 1 || row.schemaVersion !== 1) return { ok: false, code: "config-invalid" };
  return { ok: true, value: EMPTY_MARKET_CONFIG };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseOptionExpiryConfig(value: unknown):
  | Readonly<{ ok: true; value: OptionExpiryConfigV1 }>
  | Readonly<{ ok: false; code: "config-invalid"; field?: string }> {
  const row = plainRecord(value);
  if (!row || Reflect.ownKeys(row).length !== 2 || row.schemaVersion !== 1 ||
      typeof row.expiry !== "string" || row.expiry.length > 10 || row.expiry.trim() !== row.expiry || CONTROL.test(row.expiry) ||
      (row.expiry !== "" && !validDate(row.expiry))) return { ok: false, code: "config-invalid", field: "expiry" };
  return { ok: true, value: Object.freeze({ schemaVersion: 1, expiry: row.expiry }) };
}

export function createDefaultOptionExpiryConfig(): OptionExpiryConfigV1 {
  return Object.freeze({ schemaVersion: 1, expiry: "" });
}
