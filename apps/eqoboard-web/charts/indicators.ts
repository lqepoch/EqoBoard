/*
 * Indicator conventions are reimplemented from EqoBoard's MIT-licensed
 * chart studies at web/lib/indicators.ts
 * (source commit fea1e952add7a11e799d6f9f198ddcee47fd12b6). See NOTICE.
 */
import type { ChartIndicatorValues, ChartPlotBar, IndicatorId, IndicatorPoint } from "./types";

const validPeriod = (period: number): boolean => Number.isSafeInteger(period) && period > 0;

function simpleMovingAverage<TRow>(
  bars: readonly ChartPlotBar<TRow>[],
  period: number,
): IndicatorPoint[] {
  if (!validPeriod(period) || bars.length < period) return [];
  const result: IndicatorPoint[] = [];
  let sum = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!bar) return [];
    sum += bar.close;
    if (index >= period) {
      const outgoing = bars[index - period];
      if (!outgoing) return [];
      sum -= outgoing.close;
    }
    if (index >= period - 1) result.push({ time: bar.time, value: sum / period });
  }
  return result;
}

function exponentialMovingAverage<TRow>(
  bars: readonly ChartPlotBar<TRow>[],
  period: number,
): IndicatorPoint[] {
  if (!validPeriod(period) || bars.length < period) return [];
  const multiplier = 2 / (period + 1);
  const first = bars[0];
  if (!first) return [];
  let previous = first.close;
  const result: IndicatorPoint[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!bar) return [];
    if (index > 0) previous = bar.close * multiplier + previous * (1 - multiplier);
    if (index >= period - 1) result.push({ time: bar.time, value: previous });
  }
  return result;
}

/** Cumulative VWAP over the loaded rows; without a calendar contract, it is not session VWAP. */
function cumulativeLoadedWindowVwap<TRow>(bars: readonly ChartPlotBar<TRow>[]): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    if (cumulativeVolume > 0) {
      result.push({ time: bar.time, value: cumulativePriceVolume / cumulativeVolume });
    }
  }
  return result;
}

/** Wilder RSI with the legacy indicator's relative-strength fallback of 100 when avgLoss is zero. */
function wilderRsi<TRow>(bars: readonly ChartPlotBar<TRow>[], period = 14): IndicatorPoint[] {
  if (!validPeriod(period) || bars.length <= period) return [];
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    if (!current || !previous) return [];
    const change = current.close - previous.close;
    averageGain += Math.max(change, 0) / period;
    averageLoss += Math.max(-change, 0) / period;
  }

  const value = (): number => {
    const relativeStrength = averageLoss === 0 ? 100 : averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  };

  const initial = bars[period];
  if (!initial) return [];
  const result: IndicatorPoint[] = [{ time: initial.time, value: value() }];
  for (let index = period + 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    if (!current || !previous) return [];
    const change = current.close - previous.close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    result.push({ time: current.time, value: value() });
  }
  return result;
}

type MacdValues = NonNullable<ChartIndicatorValues["panes"]["macd"]>;

function movingAverageValues<TRow>(bars: readonly ChartPlotBar<TRow>[], period: number): number[] {
  const multiplier = 2 / (period + 1);
  const result: number[] = [];
  let previous = bars[0]?.close ?? 0;
  bars.forEach((bar, index) => {
    if (index > 0) previous = bar.close * multiplier + previous * (1 - multiplier);
    result.push(previous);
  });
  return result;
}

function macdValues<TRow>(
  bars: readonly ChartPlotBar<TRow>[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdValues {
  if (bars.length < slow) return { macd: [], signal: [], histogram: [] };
  const fastValues = movingAverageValues(bars, fast);
  const slowValues = movingAverageValues(bars, slow);
  const macdLine: IndicatorPoint[] = [];
  for (let index = slow - 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const fastValue = fastValues[index];
    const slowValue = slowValues[index];
    if (!bar || fastValue === undefined || slowValue === undefined)
      return { macd: [], signal: [], histogram: [] };
    macdLine.push({ time: bar.time, value: fastValue - slowValue });
  }
  const multiplier = 2 / (signal + 1);
  let previous = macdLine[0]?.value ?? 0;
  const signalLine: IndicatorPoint[] = macdLine.map((point, index) => {
    if (index > 0) previous = point.value * multiplier + previous * (1 - multiplier);
    return { time: point.time, value: previous };
  });
  const histogram: IndicatorPoint[] = [];
  for (let index = 0; index < macdLine.length; index += 1) {
    const point = macdLine[index];
    const signalPoint = signalLine[index];
    if (!point || !signalPoint) return { macd: [], signal: [], histogram: [] };
    histogram.push({ time: point.time, value: point.value - signalPoint.value });
  }
  return { macd: macdLine, signal: signalLine, histogram };
}

function bollingerBands<TRow>(bars: readonly ChartPlotBar<TRow>[], period = 20, deviation = 2) {
  const middle = simpleMovingAverage(bars, period);
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  if (!validPeriod(period) || bars.length < period) return { upper, middle, lower };
  for (let index = period - 1; index < bars.length; index += 1) {
    const window = bars.slice(index - period + 1, index + 1);
    const center = middle[index - period + 1];
    const current = bars[index];
    if (!center || !current || window.length !== period) return { upper: [], middle, lower: [] };
    const mean = center.value;
    let squaredDeviation = 0;
    for (const bar of window) {
      if (!bar) return { upper: [], middle, lower: [] };
      squaredDeviation += (bar.close - mean) ** 2;
    }
    const variance = squaredDeviation / period;
    const standardDeviation = Math.sqrt(variance);
    upper.push({ time: current.time, value: mean + deviation * standardDeviation });
    lower.push({ time: current.time, value: mean - deviation * standardDeviation });
  }
  return { upper, middle, lower };
}

export function calculateChartIndicators<TRow>(
  bars: readonly ChartPlotBar<TRow>[],
  selected: readonly IndicatorId[],
): ChartIndicatorValues {
  const enabled = new Set(selected);
  return {
    overlays: {
      SMA20: enabled.has("SMA20") ? simpleMovingAverage(bars, 20) : null,
      SMA50: enabled.has("SMA50") ? simpleMovingAverage(bars, 50) : null,
      SMA200: enabled.has("SMA200") ? simpleMovingAverage(bars, 200) : null,
      EMA20: enabled.has("EMA20") ? exponentialMovingAverage(bars, 20) : null,
      // There is no exchange-calendar/session contract in the chart response, so this is
      // intentionally cumulative over the loaded window and must be labeled that way.
      VWAP: enabled.has("VWAP") ? cumulativeLoadedWindowVwap(bars) : null,
      bollinger: enabled.has("BOLL") ? bollingerBands(bars) : null,
    },
    panes: {
      rsi: enabled.has("RSI") ? wilderRsi(bars) : null,
      macd: enabled.has("MACD") ? macdValues(bars) : null,
    },
  };
}
