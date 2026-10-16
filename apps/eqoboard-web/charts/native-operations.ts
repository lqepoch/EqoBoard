import type { NativeDataOperationMap } from "../features/data/operations";

/** The chart registration receives only its two closed history/archive read operations. */
export type NativeChartOperationMap = Pick<
  NativeDataOperationMap,
  "market.history.core-bars" | "market.archive.diagnostic-bars"
>;
