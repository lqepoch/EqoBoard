/** Compare RFC3339 instants at nanosecond precision without Date truncation. */
export function compareRfc3339Nanos(left: string, right: string): number | null {
  const parse = (value: string): bigint | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
    if (!match) return null;
    const [, y, mo, d, h, mi, s, fraction = "", zone, sign, oh = "0", om = "0"] = match;
    const year = Number(y), month = Number(mo), day = Number(d);
    const hour = Number(h), minute = Number(mi), second = Number(s);
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return null;
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
    return BigInt(epochMs) * 1_000_000n + nanos + (second === 60 ? 1_000_000_000n : 0n);
  };
  const a = parse(left), b = parse(right);
  if (a === null || b === null) return null;
  return a < b ? -1 : a > b ? 1 : 0;
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
