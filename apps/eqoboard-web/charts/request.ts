import type { CoreBarsReadInput } from "../features/data/operations";
import type { CoreBarsPageRequest } from "../features/market/core-bars-page";
import type { NativeChartConfigV1 } from "../widgets/implementations/charts/config";
import type { DecodedCoreBarsPage } from "./core-bars";

export const MAX_HISTORY_PAGES = 20;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

const AUTO_RESOLUTION: Readonly<
  Record<NativeChartConfigV1["range"], NonNullable<CoreBarsReadInput["resolution"]>>
> = {
  "1D": "1m",
  "5D": "5m",
  "1M": "1h",
  "6M": "1d",
  YTD: "1d",
  "1Y": "1d",
  "5Y": "1d",
  MAX: "1d",
};

export function resolveChartResolution(
  config: NativeChartConfigV1,
): NonNullable<CoreBarsReadInput["resolution"]> {
  return config.resolution === "auto" ? AUTO_RESOLUTION[config.range] : config.resolution;
}

export function chartRefreshIntervalMs(range: NativeChartConfigV1["range"]): number {
  return range === "1D" ? 8_000 : 60_000;
}

/** Fully specifies the bounded same-origin history operation; never provides a URL/provider name. */
export function buildCoreBarsReadInput(
  symbol: string,
  config: NativeChartConfigV1,
): CoreBarsReadInput {
  return {
    symbol,
    range: config.range,
    resolution: resolveChartResolution(config),
    asset_class: config.assetClass,
    session_scope: config.sessionScope,
    adjustment: config.adjustment,
    provider_mode: config.providerPreference,
    allow_daily_downgrade: config.allowDailyDowngrade,
  };
}

export function chartSelectionKey(input: CoreBarsReadInput): string {
  return JSON.stringify([
    input.symbol,
    input.range,
    input.resolution,
    input.asset_class,
    input.session_scope,
    input.adjustment,
    input.provider_mode,
    input.allow_daily_downgrade,
  ]);
}

/** Checks that the server echoed the full request selection and exact continuation tuple. */
export function coreBarsPageMatchesInput(
  page: DecodedCoreBarsPage,
  input: CoreBarsReadInput,
): boolean {
  const request: CoreBarsPageRequest = page.envelope.request;
  const hasContinuationTuple =
    input.request_start !== undefined ||
    input.request_end !== undefined ||
    input.cursor !== undefined;
  const matchesWindow = hasContinuationTuple
    ? request.request_start === input.request_start &&
      request.request_end === input.request_end &&
      request.cursor === input.cursor
    : request.cursor === null;
  return (
    request.symbol === input.symbol &&
    request.range === input.range &&
    request.resolution === input.resolution &&
    request.asset_class === input.asset_class &&
    request.session_scope === input.session_scope &&
    request.adjustment === input.adjustment &&
    request.provider_mode === input.provider_mode &&
    request.allow_daily_downgrade === input.allow_daily_downgrade &&
    matchesWindow
  );
}

/** Response cursors are opaque but still bounded before storage or another request. */
export function usableContinuationCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2_048 &&
    new TextEncoder().encode(value).byteLength <= 2_048 &&
    !containsControlCharacter(value)
  );
}

export function coreBarsWindowKey(request: CoreBarsPageRequest): string {
  return `${pageSelectionKey(request)}|${request.request_start}|${request.request_end}`;
}

function pageSelectionKey(request: CoreBarsPageRequest): string {
  return JSON.stringify([
    request.symbol,
    request.range,
    request.resolution,
    request.asset_class,
    request.session_scope,
    request.adjustment,
    request.provider_mode,
    request.allow_daily_downgrade,
  ]);
}

export function withinCoreBarsWindow(seconds: number, request: CoreBarsPageRequest): boolean {
  const start = Date.parse(request.request_start) / 1_000;
  const end = Date.parse(request.request_end) / 1_000;
  return Number.isFinite(start) && Number.isFinite(end) && seconds >= start && seconds < end;
}
