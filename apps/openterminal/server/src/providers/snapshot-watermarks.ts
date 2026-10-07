import { compareRfc3339Nanos } from "./market-time.ts";

export type WatermarkFeed = "stocks" | "options";
export type GatewayWatermark = {
  feed?: WatermarkFeed;
  connection_epoch: number;
  request_start_sequence?: number | null;
  local_sequence: number;
};
export type SnapshotWatermark = GatewayWatermark & {
  feed: WatermarkFeed;
  symbols: string[];
  event_types: Array<"quote" | "trade">;
  as_of_by_symbol: Record<string, string | null>;
};
type TimedSymbol = { symbol: string; quote_at?: string | null; trade_at?: string | null };

/** Split the Gateway's connection barrier by market event type without borrowing timestamps. */
export function splitSnapshotWatermarks(
  feed: WatermarkFeed,
  watermark: GatewayWatermark | null | undefined,
  records: TimedSymbol[],
): SnapshotWatermark[] {
  if (!watermark) return [];
  const bySymbol = new Map(records.map((record) => [record.symbol, record]));
  const symbols = [...bySymbol.keys()];
  if (symbols.length === 0) return [];
  return (["quote", "trade"] as const).map((eventType) => ({
    feed,
    symbols,
    event_types: [eventType],
    connection_epoch: watermark.connection_epoch,
    request_start_sequence: watermark.request_start_sequence ?? null,
    local_sequence: watermark.local_sequence,
    as_of_by_symbol: Object.fromEntries(symbols.map((symbol) => {
      const record = bySymbol.get(symbol)!;
      const value = eventType === "quote" ? record.quote_at : record.trade_at;
      return [symbol, value && compareRfc3339Nanos(value, value) !== null ? value : null];
    })),
  }));
}
