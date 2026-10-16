// Header fields from yfinance (yahoo-finance2, MIT). Unofficial endpoint; values can be delayed or absent.
import YahooFinance from 'yahoo-finance2';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export async function quoteHeader(symbol) {
  const q = await yahooFinance.quote(symbol);
  return {
    symbol,
    name: q.shortName ?? q.longName ?? null,
    open: num(q.regularMarketOpen),
    high: num(q.regularMarketDayHigh),
    low: num(q.regularMarketDayLow),
    prevClose: num(q.regularMarketPreviousClose),
    volume: num(q.regularMarketVolume),
    averageVolume: num(q.averageDailyVolume3Month ?? q.averageDailyVolume10Day),
    marketCap: num(q.marketCap),
    sharesOutstanding: num(q.sharesOutstanding),
    trailingPe: num(q.trailingPE),
    week52High: num(q.fiftyTwoWeekHigh),
    week52Low: num(q.fiftyTwoWeekLow),
    marketTime: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
  };
}
