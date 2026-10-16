// New York wall-clock helpers. Futu returns K-line times as exchange-local strings
// ("YYYY-MM-DD HH:mm:ss" in America/New_York); these convert them to UTC epoch seconds.
const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const NY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function nyWallAsUtcMs(utcMs) {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** "YYYY-MM-DD HH:mm:ss" (New York wall clock) -> UTC epoch seconds, or null. */
export function etToEpochSec(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text ?? ''));
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  let guess = wall;
  for (let i = 0; i < 2; i += 1) guess = wall - (nyWallAsUtcMs(guess) - guess);
  return Math.floor(guess / 1000);
}

/** New York calendar date "YYYY-MM-DD" for a UTC epoch in milliseconds. */
export function etDateKey(ms) {
  return NY_DATE.format(new Date(ms));
}
