/** Maximum accepted source-clock lead over a server publication timestamp. */
export const FUTURE_EVENT_SKEW_MS = 1_000;

function rfc3339Nanos(value: string): bigint | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction = "", zone, sign, oh = "0", om = "0"] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);
  // Reject leap seconds until the upstream timestamp source and deployment
  // calendar provide a verified leap-second table.
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let epochMs = date.getTime();
  if (!Number.isFinite(epochMs)) return null;
  if (zone.toUpperCase() !== "Z") {
    const offsetHours = Number(oh), offsetMinutes = Number(om);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    const offset = (offsetHours * 60 + offsetMinutes) * 60_000 * (sign === "+" ? 1 : -1);
    epochMs -= offset;
  }
  const nanos = BigInt((fraction + "000000000").slice(0, 9));
  return BigInt(epochMs) * 1_000_000n + nanos;
}

/** Compare RFC3339 instants at nanosecond precision without Date truncation. */
export function compareRfc3339Nanos(left: string, right: string): number | null {
  const a = rfc3339Nanos(left), b = rfc3339Nanos(right);
  if (a === null || b === null) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when source time is no more than toleranceMs ahead of its server reference. */
export function isWithinFutureSkew(sourceTime: string, referenceTime: string, toleranceMs: number): boolean | null {
  if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) return null;
  const source = rfc3339Nanos(sourceTime), reference = rfc3339Nanos(referenceTime);
  if (source === null || reference === null) return null;
  return source <= reference + BigInt(toleranceMs) * 1_000_000n;
}

/** Return the latest valid instant while preserving its original RFC3339 text. */
export function latestRfc3339Nanos(values: Iterable<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value || compareRfc3339Nanos(value, value) === null) continue;
    if (latest === null || compareRfc3339Nanos(value, latest) === 1) latest = value;
  }
  return latest;
}
