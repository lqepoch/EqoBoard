import type { Time } from "lightweight-charts";

const ET_INSTANT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const ET_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

function timeToDate(time: Time): Date | null {
  if (typeof time === "number") {
    const date = new Date(Number(time) * 1_000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof time === "string") {
    const date = new Date(time);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const date = new Date(Date.UTC(time.year, time.month - 1, time.day));
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Formats a UTC chart coordinate in New York time without changing the source timestamp. */
export function formatChartAxisTimeEt(time: Time, timeVisible: boolean): string {
  const date = timeToDate(time);
  if (!date) return "time unavailable";
  return `${(timeVisible ? ET_INSTANT : ET_DATE).format(date)} ET`;
}

/** Crosshair output includes both the ET presentation and the UTC coordinate used by Core. */
export function formatChartCrosshairTimeEtAndUtc(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1_000);
  if (!Number.isFinite(date.getTime())) return "time unavailable";
  return `${ET_INSTANT.format(date)} ET · ${date.toISOString()} UTC`;
}
