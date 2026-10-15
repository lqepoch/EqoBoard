import type { WidgetManifestV1 } from "@/widgets/sdk/contracts";
import type { AnyWidgetRegistration, WidgetRegistration } from "@/widgets/registry/types";
import type { NativeActionMap, NativeDataOperationMap } from "@/features/data/operations";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import type { WidgetOperationMap } from "@/widgets/sdk/data";
import type { ResearchDataOperationMap } from "@/features/research/data";
import { RESEARCH_VIEW_DEFINITIONS, createDefaultResearchViewConfig, parseResearchViewConfig, type ResearchViewConfigV1, type ResearchViewId } from "./ResearchViews";
import { ResearchViewWidget } from "./ResearchViews";
import { ResearchAiWidget, type ResearchAiConfigV1 } from "./ResearchAiWidget";
import { SavedQueriesWidget, type SavedQueriesConfigV1 } from "./SavedQueriesWidget";
import { emptyResearchQueryConfig, parseResearchQueryConfig, RESEARCH_QUERY_CONFIG_SCHEMA_ID } from "@/features/research/query-config";
import { YfinanceDailyWidget } from "./YfinanceDailyWidget";
import {
  DEFAULT_YFINANCE_RESEARCH_CONFIG,
  parseYfinanceResearchConfig,
  type YfinanceResearchConfigV1,
} from "@/features/research/yfinance";
import {
  DEFAULT_REGISTERED_PREDICTION_CONFIG,
  parseRegisteredPredictionConfig,
  type RegisteredPredictionConfigV1,
} from "@/features/research/predictions";
import { RegisteredPredictionsWidget } from "./RegisteredPredictionsWidget";
import { EngineOfflinePreviewWidget, type EngineOfflinePreviewConfigV1 } from "./EngineOfflinePreviewWidget";
import { RecapWidget, type ResearchRecapConfigV1 } from "./RecapWidget";

const SOURCE_REPOSITORY = "https://github.com/lqepoch/EqoBoard";
const NOTICE_PATH = "LICENSE";
const AUDIT_REFERENCE = "docs/migration/OPENBB_CAPABILITY_MATRIX.md";

function provenance(id: string, sourcePath: string) {
  return Object.freeze({
    provenanceId: id,
    origin: "first-party" as const,
    sourceRepository: SOURCE_REPOSITORY,
    sourcePath,
    sourceCommit: null,
    license: "MIT",
    noticePath: NOTICE_PATH,
    auditReference: AUDIT_REFERENCE,
  });
}

function symbolInput() {
  return Object.freeze([{ name: "symbol" as const, kind: "symbol" as const, source: "symbol-binding" as const, required: true as const }]);
}

function exactDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor?.enumerable || !("value" in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseSchemaVersionConfig(value: unknown):
  | Readonly<{ ok: true; value: Readonly<{ schemaVersion: 1 }> }>
  | Readonly<{ ok: false; code: "config-invalid" }> {
  const record = exactDataRecord(value, ["schemaVersion"]);
  if (!record || record.schemaVersion !== 1) return { ok: false, code: "config-invalid" };
  return { ok: true, value: Object.freeze({ schemaVersion: 1 }) };
}

function createViewManifest(view: ResearchViewId, title: string, description: string, withSymbol: boolean): WidgetManifestV1 {
  const id = `eqoboard.research.${view}`;
  return {
    manifestVersion: 1,
    sdkVersion: 1,
    id,
    version: "1.0.0",
    title,
    description,
    category: "research",
    rendererId: `${id}.renderer.v1`,
    configSchemaId: `${id}.config.v1`,
    defaultSize: { w: 6, h: 5, minW: 3, minH: 3, maxW: 12, maxH: 12 },
    inputs: withSymbol ? symbolInput() : [],
    requiredPermissions: ["research:read"],
    refresh: { mode: "none" },
    symbolBinding: withSymbol ? "active-or-fixed" : "unsupported",
    provenanceId: `${id}.provenance.v1`,
    provenancePolicy: "surface-response-evidence",
  };
}

function createViewRegistration(view: ResearchViewId): WidgetRegistration<ResearchViewConfigV1, ResearchDataOperationMap, WidgetNoActionMap> {
  const definition = RESEARCH_VIEW_DEFINITIONS.find((entry) => entry.id === view)!;
  const withSymbol = view === "news" || view === "earnings-calendar" || view === "earnings-history" || view === "insider";
  const manifest = createViewManifest(view, definition.title, `${definition.title} observations from bounded, same-origin research reads.`, withSymbol);
  return {
    manifest,
    allowedReadOperations: [definition.operation],
    allowedActions: [],
    Component: (props) => <ResearchViewWidget {...props} definition={definition} />,
    parseConfig: (value) => parseResearchViewConfig(view, value),
    createDefaultConfig: () => createDefaultResearchViewConfig(view),
    provenance: provenance(manifest.provenanceId, "apps/eqoboard-web/widgets/research/ResearchViews.tsx"),
  };
}

const savedQueriesId = "eqoboard.research.saved-queries";
const savedQueriesManifest: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: savedQueriesId,
  version: "1.0.0",
  title: "Saved research queries",
  description: "Persist bounded native view filters as workspace widget configuration and compare their current observations.",
  category: "research",
  rendererId: `${savedQueriesId}.renderer.v1`,
  configSchemaId: RESEARCH_QUERY_CONFIG_SCHEMA_ID,
  defaultSize: { w: 6, h: 6, minW: 4, minH: 4, maxW: 12, maxH: 12 },
  inputs: [],
  requiredPermissions: ["research:read"],
  refresh: { mode: "none" },
  symbolBinding: "unsupported",
  provenanceId: `${savedQueriesId}.provenance.v1`,
  provenancePolicy: "surface-response-evidence",
};

const SAVED_QUERY_OPERATIONS = [
  "research.news", "research.macro", "research.economicCalendar", "research.earningsCalendar",
  "research.earningsHistory", "research.insider", "research.screener", "research.heatmap",
  "research.crypto", "research.cryptoGlobal",
] as const satisfies readonly (keyof ResearchDataOperationMap)[];

const savedQueriesRegistration: WidgetRegistration<SavedQueriesConfigV1, ResearchDataOperationMap, WidgetNoActionMap> = {
  manifest: savedQueriesManifest,
  allowedReadOperations: SAVED_QUERY_OPERATIONS,
  allowedActions: [],
  Component: SavedQueriesWidget,
  parseConfig(value) {
    const parsed = parseResearchQueryConfig(value);
    return parsed.ok ? parsed : { ok: false, code: "config-invalid" };
  },
  createDefaultConfig: emptyResearchQueryConfig,
  provenance: provenance(savedQueriesManifest.provenanceId, "apps/eqoboard-web/widgets/research/SavedQueriesWidget.tsx"),
};

const recapId = "eqoboard.research.recap";
const recapManifest: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: recapId,
  version: "1.0.0",
  title: "Market recap",
  description: "A bounded, partially covered view of macro, TradingView listing metadata, Gateway SIP observations, and source-linked headlines.",
  category: "research",
  rendererId: `${recapId}.renderer.v1`,
  configSchemaId: `${recapId}.config.v1`,
  defaultSize: { w: 8, h: 8, minW: 5, minH: 5, maxW: 12, maxH: 12 },
  inputs: [],
  requiredPermissions: ["research:read", "market:read"],
  refresh: { mode: "poll", minIntervalMs: 15_000, maxRequestsPerMinute: 4, maxConcurrentRequests: 1, whenHidden: "pause" },
  symbolBinding: "unsupported",
  provenanceId: `${recapId}.provenance.v1`,
  provenancePolicy: "surface-response-evidence",
};

const recapRegistration: WidgetRegistration<ResearchRecapConfigV1, Pick<ResearchDataOperationMap, "research.recap">, WidgetNoActionMap> = {
  manifest: recapManifest,
  allowedReadOperations: ["research.recap"],
  allowedActions: [],
  Component: RecapWidget,
  parseConfig: parseSchemaVersionConfig,
  createDefaultConfig: () => ({ schemaVersion: 1 }),
  provenance: provenance(recapManifest.provenanceId, "apps/eqoboard-web/widgets/research/RecapWidget.tsx"),
};

const aiId = "eqoboard.research.ai-assistant";
const aiManifest: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: aiId,
  version: "1.0.0",
  title: "AI research assistant",
  description: "Bounded prompt and response through the authorized same-origin AI action.",
  category: "research",
  rendererId: `${aiId}.renderer.v1`,
  configSchemaId: `${aiId}.config.v1`,
  defaultSize: { w: 6, h: 5, minW: 3, minH: 3, maxW: 12, maxH: 12 },
  inputs: [],
  requiredPermissions: ["research:ai"],
  refresh: { mode: "none" },
  symbolBinding: "unsupported",
  provenanceId: `${aiId}.provenance.v1`,
  provenancePolicy: "no-market-data",
};

function parseAiConfig(value: unknown):
  | Readonly<{ ok: true; value: ResearchAiConfigV1 }>
  | Readonly<{ ok: false; code: "config-invalid" }> {
  return parseSchemaVersionConfig(value);
}

type ResearchAiActionMap = Pick<NativeActionMap, "research.ai">;

const aiRegistration: WidgetRegistration<ResearchAiConfigV1, WidgetOperationMap, ResearchAiActionMap> = {
  manifest: aiManifest,
  allowedReadOperations: [],
  allowedActions: ["research.ai"],
  Component: ResearchAiWidget,
  parseConfig: parseAiConfig,
  createDefaultConfig: () => ({ schemaVersion: 1 }),
  provenance: provenance(aiManifest.provenanceId, "apps/eqoboard-web/widgets/research/ResearchAiWidget.tsx"),
};

const yahooDailyId = "eqoboard.research.daily-history";
const yahooDailyManifest: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: yahooDailyId,
  version: "1.0.0",
  title: "Daily research history",
  description: "Yahoo daily observations displayed separately from Core/SIP history.",
  category: "research",
  rendererId: `${yahooDailyId}.renderer.v1`,
  configSchemaId: `${yahooDailyId}.config.v1`,
  defaultSize: { w: 8, h: 7, minW: 4, minH: 5, maxW: 12, maxH: 12 },
  inputs: symbolInput(),
  // The terminal widget is a navigation card; the isolated Research runtime
  // rechecks research:read before returning provider observations.
  requiredPermissions: [],
  refresh: { mode: "none" },
  symbolBinding: "active-or-fixed",
  provenanceId: `${yahooDailyId}.provenance.v1`,
  provenancePolicy: "surface-response-evidence",
};

type YahooDailyOperationMap = Pick<NativeDataOperationMap, "research.yahoo.daily">;
const yahooDailyRegistration: WidgetRegistration<YfinanceResearchConfigV1, YahooDailyOperationMap, WidgetNoActionMap> = {
  manifest: yahooDailyManifest,
  allowedReadOperations: ["research.yahoo.daily"],
  allowedActions: [],
  Component: YfinanceDailyWidget,
  parseConfig: parseYfinanceResearchConfig,
  createDefaultConfig: () => ({ ...DEFAULT_YFINANCE_RESEARCH_CONFIG, indicators: [...DEFAULT_YFINANCE_RESEARCH_CONFIG.indicators] }),
  provenance: Object.freeze({
    provenanceId: yahooDailyManifest.provenanceId,
    origin: "adapted-upstream",
    sourceRepository: SOURCE_REPOSITORY,
    sourcePath: "apps/openterminal/web/lib/yfinance-research-contract.ts",
    sourceCommit: "fea1e952add7a11e799d6f9f198ddcee47fd12b6",
    license: "MIT",
    noticePath: "apps/openterminal/LICENSE",
    auditReference: AUDIT_REFERENCE,
  }),
};

const predictionId = "eqoboard.research.registered-predictions";
const predictionManifest: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: predictionId,
  version: "1.0.0",
  title: "Registered predictions",
  description: "Read-only private research projection with promotion disabled.",
  category: "research",
  rendererId: `${predictionId}.renderer.v1`,
  configSchemaId: `${predictionId}.config.v1`,
  defaultSize: { w: 6, h: 6, minW: 4, minH: 4, maxW: 12, maxH: 12 },
  inputs: [],
  requiredPermissions: ["research:private-read"],
  refresh: { mode: "none" },
  symbolBinding: "unsupported",
  provenanceId: `${predictionId}.provenance.v1`,
  provenancePolicy: "surface-response-evidence",
};

type PredictionOperationMap = Pick<NativeDataOperationMap, "research.predictions">;
const predictionRegistration: WidgetRegistration<RegisteredPredictionConfigV1, PredictionOperationMap, WidgetNoActionMap> = {
  manifest: predictionManifest,
  allowedReadOperations: ["research.predictions"],
  allowedActions: [],
  Component: RegisteredPredictionsWidget,
  parseConfig: parseRegisteredPredictionConfig,
  createDefaultConfig: () => ({ ...DEFAULT_REGISTERED_PREDICTION_CONFIG }),
  provenance: provenance(predictionManifest.provenanceId, "apps/eqoboard-web/widgets/research/RegisteredPredictionsWidget.tsx"),
};

const enginePreviewId = "eqoboard.research.engine-offline-preview";
const enginePreviewManifest: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: enginePreviewId,
  version: "1.0.0",
  title: "Engine offline preview",
  description: "Separate best-effort synthetic Engine diagnostics; no account or market state.",
  category: "research",
  rendererId: `${enginePreviewId}.renderer.v1`,
  configSchemaId: `${enginePreviewId}.config.v1`,
  defaultSize: { w: 6, h: 5, minW: 4, minH: 4, maxW: 12, maxH: 12 },
  inputs: [],
  requiredPermissions: ["engine:offline-read"],
  refresh: { mode: "none" },
  symbolBinding: "unsupported",
  provenanceId: `${enginePreviewId}.provenance.v1`,
  provenancePolicy: "no-market-data",
};

type EngineReadOperationMap = Pick<NativeDataOperationMap, "engine.status" | "engine.preview">;
const enginePreviewRegistration: WidgetRegistration<EngineOfflinePreviewConfigV1, EngineReadOperationMap, WidgetNoActionMap> = {
  manifest: enginePreviewManifest,
  allowedReadOperations: ["engine.status", "engine.preview"],
  allowedActions: [],
  Component: EngineOfflinePreviewWidget,
  parseConfig: parseSchemaVersionConfig,
  createDefaultConfig: () => ({ schemaVersion: 1 }),
  provenance: provenance(enginePreviewManifest.provenanceId, "apps/eqoboard-web/widgets/research/EngineOfflinePreviewWidget.tsx"),
};

/** Static, audited first-party research built-ins. */
export const researchWidgetRegistrations: readonly AnyWidgetRegistration[] = Object.freeze([
  ...RESEARCH_VIEW_DEFINITIONS.map((definition) => createViewRegistration(definition.id)),
  recapRegistration,
  savedQueriesRegistration,
  aiRegistration,
  yahooDailyRegistration,
  predictionRegistration,
  enginePreviewRegistration,
]);
