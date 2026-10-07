export function futureFridayOCCDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 35);
  date.setUTCDate(date.getUTCDate() + ((5 - date.getUTCDay() + 7) % 7));
  return date.toISOString().slice(2, 10).replaceAll("-", "");
}

export const optionPutSymbol = `QQQ${futureFridayOCCDate()}P00600000`;

export type SipSnapshotFixtureOptions = {
  gatewayInstanceId?: string;
  receivedAt?: string;
  quoteAt?: string | null;
  tradeAt?: string | null;
  dailyBarAt?: string | null;
  previousDailyBarAt?: string | null;
  sourceMode?: "alpaca" | "offline_mock";
  sourceLabel?: string;
};

/** Wire-shaped Gateway response fixture; defaults intentionally model a legacy payload. */
export function sipSnapshotResponse(
  price: number,
  lastAsOf: string,
  connectionEpoch = 12,
  sequence = 0,
  options: SipSnapshotFixtureOptions = {},
) {
  const previousClose = 99;
  const gatewayInstanceId = options.gatewayInstanceId;
  const sourceMode = options.sourceMode ?? (gatewayInstanceId ? "offline_mock" : undefined);
  const sourceLabel = options.sourceLabel ?? (sourceMode === "offline_mock" ? "OFFLINE MOCK — NOT MARKET DATA" : undefined);
  const receivedAt = options.receivedAt ?? new Date().toISOString();
  return {
    feed: "sip",
    ...(gatewayInstanceId ? { gateway_instance_id: gatewayInstanceId } : {}),
    ...(sourceMode ? { source_mode: sourceMode } : {}),
    ...(sourceLabel ? { source_label: sourceLabel } : {}),
    received_at: receivedAt,
    watermark: {
      ...(gatewayInstanceId ? { gateway_instance_id: gatewayInstanceId } : {}),
      connection_epoch: connectionEpoch,
      request_start_sequence: sequence,
      local_sequence: sequence,
    },
    snapshots: [{
      symbol: "QQQ",
      ...(gatewayInstanceId ? { gateway_instance_id: gatewayInstanceId } : {}),
      ...(sourceMode ? { source_mode: sourceMode } : {}),
      ...(sourceLabel ? { source_label: sourceLabel } : {}),
      received_at: receivedAt,
      last: price,
      previous_close: previousClose,
      change_percent: ((price - previousClose) / previousClose) * 100,
      open: 99,
      high: price,
      low: 99,
      bid: price - 0.01,
      ask: price + 0.01,
      volume: 100_000,
      quote_at: options.quoteAt === undefined ? lastAsOf : options.quoteAt,
      trade_at: options.tradeAt === undefined ? lastAsOf : options.tradeAt,
      daily_bar_at: options.dailyBarAt === undefined ? lastAsOf : options.dailyBarAt,
      previous_daily_bar_at: options.previousDailyBarAt === undefined
        ? new Date(Date.parse(lastAsOf) - 86_400_000).toISOString() : options.previousDailyBarAt,
      last_as_of: lastAsOf,
      last_basis: "trade",
      updated_at: lastAsOf,
    }],
  };
}
