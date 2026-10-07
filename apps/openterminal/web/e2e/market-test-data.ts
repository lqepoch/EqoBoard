export function futureFridayOCCDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 35);
  date.setUTCDate(date.getUTCDate() + ((5 - date.getUTCDay() + 7) % 7));
  return date.toISOString().slice(2, 10).replaceAll("-", "");
}

export const optionPutSymbol = `QQQ${futureFridayOCCDate()}P00600000`;
