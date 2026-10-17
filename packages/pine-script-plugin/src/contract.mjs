/**
 * The broker/MDP/Core market schema is authoritative. These are bounded
 * read-only display projections for an isolated script runner only.
 */
export const PINE_LIMITS = Object.freeze({
  sourceBytes: 65_536,
  bars: 20_000,
  plots: 24,
  pointsPerPlot: 20_000,
  titleLength: 120,
});

export class PinePluginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinePluginError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinePluginError(code, message);
}

function record(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

function finite(value, bound = 1e15) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= bound;
}

export function inspectPineSource(source) {
  if (typeof source !== "string" ||
      new TextEncoder().encode(source).length > PINE_LIMITS.sourceBytes ||
      source.length === 0 ||
      source.includes("\0")) {
    fail("INVALID_SOURCE", "Pine source must be nonempty, UTF-8, and at most 64 KiB.");
  }
  const versions = [...source.matchAll(/^[ \t]*\/\/@version[ \t]*=[ \t]*(\d+)[ \t]*$/gm)];
  if (versions.length !== 1 || !["5", "6"].includes(versions[0][1])) {
    fail("UNSUPPORTED_VERSION", "This adapter accepts explicit Pine Script v5 or v6 only.");
  }
  const declarations = [...source.matchAll(/^[ \t]*(indicator|strategy|library)[ \t]*\(/gm)];
  if (declarations.length !== 1) {
    fail("UNSUPPORTED_SCRIPT", "Exactly one indicator(), strategy(), or library() declaration is required.");
  }
  const kind = declarations[0][1];
  if (kind !== "indicator") {
    fail("UNSUPPORTED_SCRIPT", "Only read-only indicator() execution is admitted in this release.");
  }
  // A lexical warning/gate only. Security comes from isolating the runtime
  // with no network or filesystem access, not from source regex filtering.
  if (/\brequest\s*\.\s*(security|financial|economic|seed|dividends|splits|earnings)\s*\(/u.test(source)) {
    fail("UNSUPPORTED_DATA_REQUEST", "Cross-symbol/timeframe requests require an explicit MDP read adapter.");
  }
  return Object.freeze({ version: Number(versions[0][1]), kind, sourceBytes: new TextEncoder().encode(source).length });
}

export function normalizePineBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0 || bars.length > PINE_LIMITS.bars) {
    fail("INVALID_BARS", "Historical bars must be a nonempty bounded array.");
  }
  let lastTime = -1;
  const normalized = [];
  for (const item of bars) {
    if (!record(item)) fail("INVALID_BARS", "A bar is not a plain object.");
    const { time, open, high, low, close, volume } = item;
    if (!Number.isSafeInteger(time) || time < 0 || time > 4_102_444_800 || time <= lastTime ||
      ![open, high, low, close].every(value => finite(value, 1e12)) ||
      !finite(volume) || volume < 0 ||
      high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      fail("INVALID_BARS", "Bars must be strictly ascending epoch-seconds with finite OHLCV and valid high/low.");
    }
    lastTime = time;
    normalized.push(Object.freeze({
      openTime: time * 1_000,
      open, high, low, close, volume
    }));
  }
  return Object.freeze(normalized);
}

/**
 * Normalizes a PineTS-like plot map without guessing timestamps or substituting
 * zeros for na. A caller must show actual source/delay/completeness evidence.
 */
export function normalizePinePlots(raw, bars) {
  if (!record(raw) || Object.keys(raw).length > PINE_LIMITS.plots) {
    fail("INVALID_OUTPUT", "The engine returned an invalid plot collection.");
  }
  const expected = new Set(bars.map(bar => bar.openTime));
  const normalized = [];
  for (const [title, descriptor] of Object.entries(raw)) {
    if (!title || title.length > PINE_LIMITS.titleLength || !record(descriptor) ||
      !Array.isArray(descriptor.data) || descriptor.data.length > PINE_LIMITS.pointsPerPlot) {
      fail("INVALID_OUTPUT", "The engine returned an invalid plot descriptor.");
    }
    let prior = -1;
    const points = [];
    for (const point of descriptor.data) {
      if (!record(point)) fail("INVALID_OUTPUT", "The engine returned an invalid plot point.");
      const time = point.time;
      if (!Number.isSafeInteger(time) || time <= prior || !expected.has(time)) {
        fail("INVALID_OUTPUT", "Plot times must match requested bar opens in ascending milliseconds.");
      }
      prior = time;
      if (point.value === null || point.value === undefined ||
          (typeof point.value === "number" && Number.isNaN(point.value))) continue;
      if (!finite(point.value, 1e15)) {
        fail("INVALID_OUTPUT", "A Pine plot value is nonfinite or exceeds the display range.");
      }
      points.push(Object.freeze({ time: time / 1_000, value: point.value }));
    }
    normalized.push(Object.freeze({ id: title, title, kind: "line", points: Object.freeze(points) }));
  }
  return Object.freeze(normalized);
}
