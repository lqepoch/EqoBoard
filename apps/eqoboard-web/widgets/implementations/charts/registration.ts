import type { NativeChartOperationMap } from "../../../charts/native-operations";
import type { WidgetNoActionMap } from "../../../widgets/sdk/actions";
import type { MarketHostSnapshot } from "../../../stores/market/market-store";
import type { WidgetManifestV1 } from "../../../widgets/sdk/contracts";
import type { BuiltinProvenance, WidgetRegistration } from "../../../widgets/registry/types";
import { ChartWidget } from "./ChartWidget";
import { CHART_CONFIG_SCHEMA_ID, createDefaultChartConfig, parseNativeChartConfig, type NativeChartConfigV1 } from "./config";

export const chartWidgetManifest = Object.freeze({
  manifestVersion: 1,
  sdkVersion: 1,
  id: "eqoboard.chart",
  version: "1.0.0",
  title: "Chart",
  description: "Core Bars V1 history or a separately labeled MDP diagnostic archive; no live bar corrections.",
  category: "market",
  rendererId: "eqoboard.chart.v1",
  configSchemaId: CHART_CONFIG_SCHEMA_ID,
  defaultSize: { w: 8, h: 8, minW: 4, minH: 5, maxW: 12, maxH: 12 },
  inputs: [{ name: "symbol", kind: "symbol", source: "symbol-binding", required: true }],
  requiredPermissions: ["market:read"],
  refresh: {
    mode: "poll",
    minIntervalMs: 8_000,
    maxRequestsPerMinute: 8,
    maxConcurrentRequests: 1,
    whenHidden: "pause",
  },
  symbolBinding: "active-or-fixed",
  provenanceId: "eqoboard.native05.chart.v1",
  provenancePolicy: "surface-response-evidence",
} satisfies WidgetManifestV1);

export const chartWidgetProvenance = Object.freeze({
  provenanceId: "eqoboard.native05.chart.v1",
  origin: "adapted-upstream",
  sourceRepository: "lqepoch/EqoBoard",
  sourcePath: "web/components/widgets/ChartWidget.tsx; web/lib/indicators.ts",
  sourceCommit: "fea1e952add7a11e799d6f9f198ddcee47fd12b6",
  license: "MIT",
  noticePath: "apps/eqoboard-web/charts/NOTICE",
  auditReference: "native05-chart-audit.md",
} satisfies BuiltinProvenance);

export const chartWidgetRegistration: WidgetRegistration<
  NativeChartConfigV1,
  NativeChartOperationMap,
  WidgetNoActionMap,
  MarketHostSnapshot
> = {
  manifest: chartWidgetManifest,
  Component: ChartWidget,
  allowedReadOperations: Object.freeze([
    "market.history.core-bars",
    "market.archive.diagnostic-bars",
  ] as const),
  allowedActions: Object.freeze([] as const),
  parseConfig: parseNativeChartConfig,
  createDefaultConfig: createDefaultChartConfig,
  provenance: chartWidgetProvenance,
};
