import { hasControlCharacters } from "@/features/data/validation";
import type {
  GatewayMarketRecord,
  MarketFreshness,
  MarketHostSnapshot,
  MarketTransportState,
} from "@/stores/market/market-store";

export const STOCK_TAPE_ROW_LIMIT = 80;

const EMPTY_ROWS: readonly StockTapeRow[] = Object.freeze([]);
// Only RFC3339 UTC event times get a clock label; any other offset stays unknown.
const UTC_CLOCK_PATTERN = /T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/u;

export type TapeDirection = "up" | "down" | "flat" | "first";

export type StockTapeRow = Readonly<{
  id: string;
  sequence: number;
  symbol: string;
  price: number;
  size: number | null;
  clock: string | null;
  direction: TapeDirection;
  source: string;
  entitlement: string;
}>;

export type StockTapeSummary = Readonly<{
  freshness: MarketFreshness;
  transportState: MarketTransportState;
  connectionEpoch: number | null;
  source: string;
  entitlement: string;
}>;

type StockPrint = Readonly<{
  symbol: string;
  gatewayInstanceId: string;
  connectionEpoch: number;
  sequence: number;
  price: number;
  size: number | null;
  clock: string | null;
  source: string;
  entitlement: string;
}>;

function boundedText(value: unknown, max: number, fallback: string): string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlCharacters(value)
    ? value
    : fallback;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Copies the provider's UTC wall clock at its own precision; it never converts zones. */
export function utcClockLabel(eventTime: unknown): string | null {
  if (typeof eventTime !== "string" || eventTime.length > 128) return null;
  const match = UTC_CLOCK_PATTERN.exec(eventTime);
  if (!match) return null;
  const fraction = match[2];
  return fraction ? `${match[1]}.${fraction.padEnd(3, "0").slice(0, 3)}` : match[1];
}

function normalizePrint(event: GatewayMarketRecord): StockPrint | null {
  if (event.kind !== "stock_trade") return null;
  const symbol = event.symbol;
  const gatewayInstanceId = event.gateway_instance_id;
  const connectionEpoch = event.connection_epoch;
  const sequence = event.local_sequence;
  if (typeof symbol !== "string" || typeof gatewayInstanceId !== "string") return null;
  if (typeof connectionEpoch !== "number" || !Number.isSafeInteger(connectionEpoch)) return null;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) return null;
  const price = finiteNumber(event.price);
  if (price === null) return null;
  return Object.freeze({
    symbol,
    gatewayInstanceId,
    connectionEpoch,
    sequence,
    price,
    size: finiteNumber(event.size),
    clock: utcClockLabel(event.event_time),
    source: boundedText(event.source_label, 128, "source unknown"),
    entitlement: boundedText(event.source_entitlement, 64, "unknown"),
  });
}

function directionOf(previous: StockPrint | null, current: StockPrint): TapeDirection {
  if (previous === null) return "first";
  if (current.price > previous.price) return "up";
  if (current.price < previous.price) return "down";
  return "flat";
}

/**
 * Newest-first prints for one symbol on the current Gateway stream identity.
 * Tick direction compares adjacent prints only; the source has no aggressor side.
 */
export function stockTapeRows(
  snapshot: MarketHostSnapshot,
  symbol: string,
): readonly StockTapeRow[] {
  if (!symbol) return EMPTY_ROWS;
  const prints: StockPrint[] = [];
  for (const event of snapshot.stockTrades) {
    const print = normalizePrint(event);
    if (print) prints.push(print);
  }
  let newest: StockPrint | null = null;
  for (const print of prints) {
    if (newest === null || print.sequence > newest.sequence) newest = print;
  }
  if (newest === null) return EMPTY_ROWS;
  const stream: StockPrint = newest;

  const current = prints
    .filter(
      (print) =>
        print.symbol === symbol &&
        print.gatewayInstanceId === stream.gatewayInstanceId &&
        print.connectionEpoch === stream.connectionEpoch,
    )
    .sort((left, right) => left.sequence - right.sequence);

  const rows = current.map((print, index) =>
    Object.freeze({
      id: `${print.gatewayInstanceId}:${print.connectionEpoch}:${print.sequence}`,
      sequence: print.sequence,
      symbol: print.symbol,
      price: print.price,
      size: print.size,
      clock: print.clock,
      direction: directionOf(index > 0 ? current[index - 1] : null, print),
      source: print.source,
      entitlement: print.entitlement,
    }),
  );
  return Object.freeze(rows.slice(-STOCK_TAPE_ROW_LIMIT).reverse());
}

export function stockTapeSummary(snapshot: MarketHostSnapshot): StockTapeSummary {
  const feed = snapshot.feeds.stocks;
  const status = feed.rawStatus;
  return Object.freeze({
    freshness: feed.freshness,
    transportState: snapshot.transportState,
    connectionEpoch: feed.connectionEpoch,
    source: boundedText(status?.source_label, 128, "source unknown"),
    entitlement: boundedText(status?.source_entitlement, 64, "unknown"),
  });
}
