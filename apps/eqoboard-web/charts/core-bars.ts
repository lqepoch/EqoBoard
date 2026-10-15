import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
  BarsResponseV1Schema,
  type BarRowV1,
  type BarsResponseV1,
} from "@lqepoch/trading-core-contracts";
import {
  decodeCoreBarsPageEnvelope,
  type CoreBarsPageEnvelope,
  type CoreBarsPageRequest,
} from "../features/market/core-bars-page";
import { projectChartRows, type ChartProjectionResult } from "./projection";
import { withinCoreBarsWindow } from "./request";
import type { ChartDisplayEvidence, ChartPlotBar } from "./types";

export type DecodedCoreBarsPage = Readonly<{
  envelope: CoreBarsPageEnvelope;
  response: BarsResponseV1;
  projection: ChartProjectionResult<BarRowV1>;
  evidence: ChartDisplayEvidence;
}>;

function timestampSeconds(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const timestamp = value as { seconds?: unknown; nanos?: unknown };
  if (
    typeof timestamp.seconds !== "bigint" ||
    typeof timestamp.nanos !== "number" ||
    !Number.isSafeInteger(timestamp.nanos) ||
    timestamp.nanos !== 0
  )
    return null;
  const seconds = Number(timestamp.seconds);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function timestampText(value: unknown): string {
  const seconds = timestampSeconds(value);
  if (seconds === null) return "unknown";
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
}

function expectedResponseMatches(request: CoreBarsPageRequest, response: BarsResponseV1): boolean {
  const downgraded = response.effectiveResolution !== request.resolution;
  if (
    response.schemaVersion !== 1 ||
    response.requestedResolution !== request.resolution ||
    response.adjustment !== request.adjustment ||
    (downgraded && (!request.allow_daily_downgrade || response.effectiveResolution !== "1d"))
  )
    return false;
  return response.rows.every(
    (row) =>
      row.symbol === request.symbol &&
      row.assetClass === request.asset_class &&
      row.resolution === response.effectiveResolution &&
      row.adjustment === request.adjustment,
  );
}

type RowPrecision = "exact" | "provider-float" | "unknown";

function precisionByProvenance(response: BarsResponseV1): ReadonlyMap<string, RowPrecision> {
  const precision = new Map<string, RowPrecision>();
  const seen = new Set<string>();
  for (const item of response.sourceProvenance) {
    if (seen.has(item.provenanceId)) {
      precision.set(item.provenanceId, "unknown");
      continue;
    }
    seen.add(item.provenanceId);
    const encoding = item.numericEncoding;
    precision.set(
      item.provenanceId,
      encoding === "decimal_token" || encoding === "integer_token"
        ? "exact"
        : encoding === "binary_float64_shortest_decimal" ||
            encoding === "binary_float32_shortest_decimal"
          ? "provider-float"
          : "unknown",
    );
  }
  return precision;
}

function precisionForRows(
  response: BarsResponseV1,
  precisionById: ReadonlyMap<string, RowPrecision>,
): ChartDisplayEvidence["precision"] {
  if (response.rows.length === 0) return "unknown";
  const precisions = response.rows.map((row) => precisionById.get(row.provenanceId) ?? "unknown");
  if (precisions.every((precision) => precision === "exact")) return "exact-decimal";
  if (precisions.every((precision) => precision === "provider-float")) return "provider-float";
  return "unknown";
}

function projectionCandidates(
  envelope: CoreBarsPageEnvelope,
  response: BarsResponseV1,
  precisionById: ReadonlyMap<string, RowPrecision>,
) {
  return response.rows.map((row) => {
    const exactEncoding = precisionById.get(row.provenanceId) === "exact";
    const exact = exactEncoding
      ? { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }
      : undefined;
    const seconds = timestampSeconds(row.barStartUtc);
    return {
      sourceRow: row,
      timeSeconds:
        seconds !== null && withinCoreBarsWindow(seconds, envelope.request) ? seconds : Number.NaN,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      ...(exact ? { exact } : {}),
    };
  });
}

function evidenceFor(
  envelope: CoreBarsPageEnvelope,
  response: BarsResponseV1,
  rejectedRows: number,
  precisionById: ReadonlyMap<string, RowPrecision>,
): ChartDisplayEvidence {
  const sources = [
    ...new Set(response.sourceProvenance.map((source) => source.source).filter(Boolean)),
  ];
  const provider = response.provider || "unknown";
  const feed = response.feed || "unknown";
  const completeness =
    response.coverageStatus === "complete" && !response.truncated && rejectedRows === 0
      ? "complete"
      : response.coverageStatus === "unknown"
        ? "unknown"
        : "partial";
  const precision = precisionForRows(response, precisionById);
  return {
    mode: "core-bars",
    source: sources.length === 1 ? sources[0]! : sources.length > 1 ? "mixed" : "unknown",
    provider,
    feed,
    asOf: timestampText(response.asOf),
    requestedWindow: `${envelope.request.range} · ${envelope.request.request_start} → ${envelope.request.request_end}`,
    effectiveResolution: `${response.requestedResolution} → ${response.effectiveResolution}`,
    coverage: `${response.coverageStatus}; ${response.segments.length} segments; ${response.gaps.length} gaps; ${response.rows.length} response rows${response.truncated ? "; response page truncated" : ""}${rejectedRows ? `; ${rejectedRows} invalid rows omitted` : ""}`,
    completeness,
    precision,
    evidence: [
      { label: "Provider preference", value: envelope.request.provider_mode },
      { label: "Asset class", value: `${envelope.request.asset_class} (caller declared)` },
      { label: "Session scope", value: envelope.request.session_scope },
      { label: "Adjustment request", value: envelope.request.adjustment },
      { label: "Entitlement", value: response.entitlementStatus || "unknown" },
      { label: "Cache", value: response.cacheStatus || "unknown" },
      { label: "Fetched", value: timestampText(response.fetchedAt) },
      { label: "Verified at", value: timestampText(response.verifiedAt) },
      { label: "Calendar", value: response.marketCalendarVersion || "unknown" },
      {
        label: "Provenance sources",
        value: sources.length ? sources.slice(0, 8).join(", ") : "unknown",
      },
      {
        label: "Cursor",
        value: envelope.request.cursor ? "opaque continuation page" : "initial page",
      },
    ],
  };
}

/** Decodes the BFF paging envelope, then the unchanged generated Core ProtoJSON response. */
export function decodeCoreBarsPage(value: unknown): DecodedCoreBarsPage | null {
  const envelope = decodeCoreBarsPageEnvelope(value);
  if (!envelope) return null;
  let response: BarsResponseV1;
  try {
    response = fromJson(BarsResponseV1Schema, envelope.response as JsonValue);
  } catch {
    return null;
  }
  if (!expectedResponseMatches(envelope.request, response) || response.rows.length > 1_000)
    return null;
  const precisionById = precisionByProvenance(response);
  const projection = projectChartRows(projectionCandidates(envelope, response, precisionById));
  return {
    envelope,
    response,
    projection,
    evidence: evidenceFor(envelope, response, projection.rejectedRows, precisionById),
  };
}

export function coreBarsPlotRows(page: DecodedCoreBarsPage): readonly ChartPlotBar<BarRowV1>[] {
  return page.projection.bars;
}
