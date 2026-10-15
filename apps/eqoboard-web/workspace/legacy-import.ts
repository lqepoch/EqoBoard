import type { WidgetRegistry } from "../widgets/registry/types";
import type { WidgetInstanceV1 } from "../widgets/sdk/contracts";
import { fromGridCallback } from "./grid";
import {
  createId,
  WORKSPACE_LIMITS,
  type GridPlacementV1,
  type WorkspaceDocumentV1,
  type WorkspaceTabV1,
} from "./model";
import { parseWorkspaceDocument, type WorkspaceParseError } from "./schema";

export const LEGACY_WORKSPACE_STORAGE_KEY = "eqoboard-open-terminal-v1";

const LEGACY_KINDS = [
  "quote",
  "chart",
  "watchlist",
  "news",
  "heatmap",
  "screener",
  "crypto",
  "macro",
  "options",
  "ivskew",
  "optiontape",
  "vertical",
  "portfolio",
  "ai",
  "calendar",
  "insider",
  "tv",
  "recap",
  "researchpredictions",
  "enginepreview",
] as const;

type LegacyKind = (typeof LEGACY_KINDS)[number];
type LegacyWidget = Readonly<{ id: string; type: LegacyKind; symbol?: string; linked: boolean }>;
type LegacyLayoutItem = Readonly<{ i: string; x: number; y: number; w: number; h: number }>;

const MANIFEST_CANDIDATES: Readonly<Record<LegacyKind, readonly string[]>> = {
  quote: ["market.quote"],
  chart: ["eqoboard.chart"],
  watchlist: ["market.watchlist"],
  news: ["eqoboard.research.news"],
  heatmap: ["eqoboard.research.heatmap"],
  screener: ["eqoboard.research.screener"],
  crypto: ["eqoboard.research.crypto"],
  macro: ["eqoboard.research.macro"],
  options: ["market.options-chain"],
  ivskew: ["market.iv-skew"],
  optiontape: ["market.option-tape"],
  vertical: ["market.vertical-preview"],
  portfolio: ["eqoboard.portfolio.manual-ledger"],
  ai: ["eqoboard.research.ai-assistant"],
  calendar: ["eqoboard.research.economic-calendar"],
  insider: ["eqoboard.research.insider"],
  tv: [],
  recap: ["eqoboard.research.recap"],
  researchpredictions: ["eqoboard.research.registered-predictions"],
  enginepreview: ["eqoboard.research.engine-offline-preview"],
};

export type LegacyWorkspaceImportPreview = Readonly<{
  sourceKey: typeof LEGACY_WORKSPACE_STORAGE_KEY;
  document: WorkspaceDocumentV1;
  widgetCount: number;
  retainedAsInert: readonly LegacyKind[];
  adjustedWidgetIds: readonly string[];
  excludedState: readonly ["commandOpen", "optionLegs"];
  warnings: readonly string[];
}>;

export type LegacyWorkspacePreviewResult =
  | Readonly<{ ok: true; value: LegacyWorkspaceImportPreview }>
  | Readonly<{ ok: false; errors: readonly WorkspaceParseError[] }>;

const INVALID = Symbol("invalid-legacy-workspace");
type ParseErrorCode = WorkspaceParseError["code"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function error(code: ParseErrorCode, path: string, message: string): typeof INVALID {
  errors.push({ code, path, message });
  return INVALID;
}

let errors: WorkspaceParseError[] = [];

function symbol(value: unknown, path: string): string | typeof INVALID {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > WORKSPACE_LIMITS.maxSymbolLength ||
    value !== value.trim() ||
    !/^(?=.*[A-Z0-9])[A-Z0-9.\-^=&]{1,24}$/u.test(value)
  ) {
    return error("invalid-value", path, "Legacy symbol is not a bounded canonical ticker.");
  }
  return value;
}

function parseWidget(value: unknown, index: number): LegacyWidget | typeof INVALID {
  const path = `$.state.widgets[${index}]`;
  if (!isRecord(value)) return error("invalid-shape", path, "Expected a legacy widget object.");
  let valid = validContainerKeys(value, ["id", "type", "symbol", "linked"], path);
  if (
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value.id)
  ) {
    error("invalid-value", `${path}.id`, "Legacy widget identity is invalid.");
    valid = false;
  }
  if (typeof value.type !== "string" || !(LEGACY_KINDS as readonly string[]).includes(value.type)) {
    error(
      "invalid-value",
      `${path}.type`,
      "Legacy widget kind is not in the audited OpenTerminal inventory.",
    );
    valid = false;
  }
  if (typeof value.linked !== "boolean") {
    error("invalid-value", `${path}.linked`, "Legacy symbol-link mode must be boolean.");
    valid = false;
  }
  if (Object.hasOwn(value, "symbol") && value.symbol === undefined) {
    error("invalid-value", `${path}.symbol`, "Legacy symbol must be omitted or contain a ticker.");
    valid = false;
  }
  const parsedSymbol =
    value.symbol === undefined ? undefined : symbol(value.symbol, `${path}.symbol`);
  if (parsedSymbol === INVALID) valid = false;
  if (!valid) return INVALID;
  return {
    id: value.id,
    type: value.type as LegacyKind,
    linked: value.linked,
    ...(parsedSymbol ? { symbol: parsedSymbol } : {}),
  };
}

function parseLayout(value: unknown, index: number): LegacyLayoutItem | typeof INVALID {
  const path = `$.state.layout[${index}]`;
  if (!isRecord(value)) return error("invalid-shape", path, "Expected a legacy grid placement.");
  const keysValid = validContainerKeys(value, ["i", "x", "y", "w", "h"], path);
  const { i, x, y, w, h } = value;
  if (
    typeof i !== "string" ||
    i.length < 1 ||
    i.length > 128 ||
    ![x, y, w, h].every((item) => typeof item === "number" && Number.isSafeInteger(item))
  ) {
    return error("invalid-value", path, "Legacy grid placement fields are invalid.");
  }
  if (
    (x as number) < 0 ||
    (y as number) < 0 ||
    (w as number) < 1 ||
    (h as number) < 1 ||
    (x as number) > WORKSPACE_LIMITS.gridMaxRows ||
    (y as number) > WORKSPACE_LIMITS.gridMaxRows ||
    (w as number) > WORKSPACE_LIMITS.gridMaxRows ||
    (h as number) > WORKSPACE_LIMITS.gridMaxRows
  ) {
    return error(
      "grid-out-of-bounds",
      path,
      "Legacy grid placement exceeds bounded migration coordinates.",
    );
  }
  if (!keysValid) return INVALID;
  return { i, x: x as number, y: y as number, w: w as number, h: h as number };
}

function validContainerKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): boolean {
  let valid = true;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      error(
        "unknown-field",
        `${path}.${key}`,
        "This field is outside the audited legacy layout contract.",
      );
      valid = false;
    }
  }
  return valid;
}

function inertLegacyInstance(type: LegacyKind): WidgetInstanceV1 {
  return {
    instanceId: createId(),
    manifestId: `legacy.imported.${type}`,
    manifestVersion: "0.0.0",
    configSchemaId: "legacy.imported.v1",
    config: {},
  };
}

function resolveLegacyInstance(
  widget: LegacyWidget,
  registry: WidgetRegistry,
): { instance: WidgetInstanceV1; inert: boolean } {
  try {
    const manifestId = MANIFEST_CANDIDATES[widget.type].find((candidate) =>
      registry.get(candidate),
    );
    const registration = manifestId ? registry.get(manifestId) : undefined;
    if (!registration) return { inert: true, instance: inertLegacyInstance(widget.type) };
    const parsedConfig = registration.parseConfig(registration.createDefaultConfig());
    if (!parsedConfig.ok) return { inert: true, instance: inertLegacyInstance(widget.type) };
    const supportsSymbol =
      registration.manifest.symbolBinding === "active-or-fixed" &&
      registration.manifest.inputs.some((input) => input.name === "symbol");
    const symbolBinding = supportsSymbol
      ? !widget.linked && widget.symbol
        ? { mode: "fixed" as const, symbol: widget.symbol }
        : { mode: "active" as const }
      : undefined;
    return {
      inert: false,
      instance: {
        instanceId: createId(),
        manifestId: registration.manifest.id,
        manifestVersion: registration.manifest.version,
        configSchemaId: registration.manifest.configSchemaId,
        config: parsedConfig.value as WidgetInstanceV1["config"],
        ...(symbolBinding ? { symbolBinding } : {}),
      },
    };
  } catch {
    return { inert: true, instance: inertLegacyInstance(widget.type) };
  }
}

function finishFailure(): LegacyWorkspacePreviewResult {
  const result = { ok: false as const, errors };
  errors = [];
  return result;
}

/**
 * Reads the old Zustand envelope only on explicit user action. It never mutates
 * localStorage, adds no owner identity, and requires a separate import commit.
 */
export function previewLegacyWorkspaceImport(
  rawStorageText: string,
  registry: WidgetRegistry,
): LegacyWorkspacePreviewResult {
  errors = [];
  if (new TextEncoder().encode(rawStorageText).byteLength > WORKSPACE_LIMITS.maxDocumentBytes) {
    error("too-large", "$", "Legacy layout exceeds the 64 KiB preview limit.");
    return finishFailure();
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawStorageText) as unknown;
  } catch {
    error("invalid-json", "$", "The saved legacy layout is not valid JSON.");
    return finishFailure();
  }
  if (!isRecord(envelope) || !validContainerKeys(envelope, ["state", "version"], "$")) {
    if (!isRecord(envelope))
      error("invalid-shape", "$", "Expected the OpenTerminal Zustand storage envelope.");
    return finishFailure();
  }
  if (envelope.version !== 0 || !isRecord(envelope.state)) {
    error(
      "unsupported-version",
      "$.version",
      "Only the audited OpenTerminal Zustand version 0 layout can be previewed.",
    );
    return finishFailure();
  }
  const state = envelope.state;
  if (
    !validContainerKeys(
      state,
      ["activeSymbol", "widgets", "layout", "watchlist", "commandOpen", "optionLegs"],
      "$.state",
    )
  ) {
    return finishFailure();
  }
  const activeSymbol = symbol(state.activeSymbol, "$.state.activeSymbol");
  if (
    !Array.isArray(state.watchlist) ||
    state.watchlist.length > WORKSPACE_LIMITS.maxWatchlistSymbols
  ) {
    error(
      "too-many-items",
      "$.state.watchlist",
      "Legacy watchlist must be an array of at most 100 symbols.",
    );
  }
  if (!Array.isArray(state.widgets) || state.widgets.length > WORKSPACE_LIMITS.maxWidgetsPerTab) {
    error(
      "too-many-items",
      "$.state.widgets",
      "A legacy layout can import at most 24 widgets into one tab.",
    );
  }
  if (!Array.isArray(state.layout) || state.layout.length > WORKSPACE_LIMITS.maxWidgetsPerTab) {
    error("too-many-items", "$.state.layout", "Legacy placements must contain at most 24 entries.");
  }
  if (
    errors.length > 0 ||
    activeSymbol === INVALID ||
    !Array.isArray(state.widgets) ||
    !Array.isArray(state.layout) ||
    !Array.isArray(state.watchlist)
  ) {
    return finishFailure();
  }

  const widgets: LegacyWidget[] = [];
  state.widgets.forEach((value, index) => {
    const parsed = parseWidget(value, index);
    if (parsed !== INVALID) widgets.push(parsed);
  });
  const placements: LegacyLayoutItem[] = [];
  state.layout.forEach((value, index) => {
    const parsed = parseLayout(value, index);
    if (parsed !== INVALID) placements.push(parsed);
  });
  const watchlist: string[] = [];
  state.watchlist.forEach((value, index) => {
    const parsed = symbol(value, `$.state.watchlist[${index}]`);
    if (parsed !== INVALID) watchlist.push(parsed);
  });
  const widgetIdSet = new Set(widgets.map((widget) => widget.id));
  const placementIdSet = new Set(placements.map((placement) => placement.i));
  if (widgetIdSet.size !== widgets.length || placementIdSet.size !== placements.length) {
    error("duplicate-id", "$.state", "Legacy widget and placement IDs must be unique.");
  }
  if (
    widgetIdSet.size !== placementIdSet.size ||
    [...widgetIdSet].some((id) => !placementIdSet.has(id))
  ) {
    error(
      "missing-reference",
      "$.state.layout",
      "Each legacy widget must have one matching grid placement.",
    );
  }
  if (new Set(watchlist.map((value) => value.toUpperCase())).size !== watchlist.length) {
    error("duplicate-symbol", "$.state.watchlist", "Legacy watchlist entries must be unique.");
  }
  if (
    errors.length > 0 ||
    widgets.length !== state.widgets.length ||
    placements.length !== state.layout.length ||
    watchlist.length !== state.watchlist.length
  ) {
    return finishFailure();
  }

  const instanceByOldId = new Map<string, WidgetInstanceV1>();
  const inertKinds = new Set<LegacyKind>();
  for (const widget of widgets) {
    const resolved = resolveLegacyInstance(widget, registry);
    instanceByOldId.set(widget.id, resolved.instance);
    if (resolved.inert) inertKinds.add(widget.type);
  }
  const workspaceId = createId();
  const tabId = createId();
  const instances = widgets.map((widget) => instanceByOldId.get(widget.id)!);
  const candidateTab: WorkspaceTabV1 = {
    id: tabId,
    name: "Imported layout",
    widgets: instances,
    placements: placements.map((placement) => ({
      ...placement,
      i: instanceByOldId.get(placement.i)!.instanceId,
    })),
    maximizedInstanceId: null,
  };
  const gridResult = fromGridCallback(candidateTab.placements, candidateTab, registry);
  if (!gridResult.ok) {
    error(
      "grid-out-of-bounds",
      "$.state.layout",
      "Legacy layout cannot fit the native 12-column, 500-row grid.",
    );
    return finishFailure();
  }
  const adjustedWidgetIds = gridResult.placements
    .filter((placement) => {
      const original = candidateTab.placements.find((item) => item.i === placement.i);
      return (
        !original ||
        original.x !== placement.x ||
        original.y !== placement.y ||
        original.w !== placement.w ||
        original.h !== placement.h
      );
    })
    .map((placement) => placement.i);
  const tab: WorkspaceTabV1 = { ...candidateTab, placements: gridResult.placements };
  const document: WorkspaceDocumentV1 = {
    schemaVersion: 1,
    activeWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name: "Imported OpenTerminal layout",
        activeTabId: tabId,
        marketContext: { activeSymbol, watchlist },
        tabs: [tab],
      },
    ],
    userTemplates: [],
  };
  const parsedDocument = parseWorkspaceDocument(document);
  if (!parsedDocument.ok) {
    errors = [...parsedDocument.errors];
    return finishFailure();
  }
  const warnings: string[] = [];
  if (inertKinds.size > 0)
    warnings.push(
      "Some legacy widget types have no native registration and will be retained as inert tiles.",
    );
  if (adjustedWidgetIds.length > 0)
    warnings.push(
      "Some legacy grid placements were adjusted to the native 12-column grid and widget size constraints.",
    );
  if (
    state.commandOpen === true ||
    (Array.isArray(state.optionLegs) && state.optionLegs.length > 0)
  ) {
    warnings.push(
      "Transient command state and option-leg/order state are excluded from workspace migration.",
    );
  }
  const result: LegacyWorkspacePreviewResult = {
    ok: true,
    value: {
      sourceKey: LEGACY_WORKSPACE_STORAGE_KEY,
      document: parsedDocument.value,
      widgetCount: widgets.length,
      retainedAsInert: [...inertKinds],
      adjustedWidgetIds,
      excludedState: ["commandOpen", "optionLegs"],
      warnings,
    },
  };
  errors = [];
  return result;
}
