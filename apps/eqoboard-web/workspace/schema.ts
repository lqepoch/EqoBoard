import {
  WORKSPACE_EXPORT_FORMAT,
  WORKSPACE_LIMITS,
  WORKSPACE_SCHEMA_VERSION,
  type GridPlacementV1,
  type JsonValue,
  type WorkspaceDocumentV1,
  type WorkspaceExportV1,
  type WorkspaceMarketContextV1,
  type WorkspaceTabV1,
  type WorkspaceTemplateV1,
  type WorkspaceV1,
  type WorkspaceWidgetInstanceV1,
} from "./model";
import { parseWidgetInstanceV1 } from "../widgets/sdk/manifest";

export type WorkspaceParseErrorCode =
  | "invalid-json"
  | "unsupported-version"
  | "invalid-shape"
  | "unknown-field"
  | "invalid-value"
  | "duplicate-id"
  | "duplicate-symbol"
  | "missing-reference"
  | "grid-out-of-bounds"
  | "grid-overlap"
  | "too-large"
  | "too-many-items";

export type WorkspaceParseError = Readonly<{
  code: WorkspaceParseErrorCode;
  path: string;
  message: string;
}>;

export type WorkspaceParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly WorkspaceParseError[] }>;

const INVALID = Symbol("invalid");
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_CONFIG_KEYS = new Set([
  "account", "accountid", "accesstoken", "authorization", "auth", "cookie", "idtoken",
  "issuer", "orders", "order", "owner", "positions", "refreshtoken", "session",
  "storagepartition", "subject", "token", "marketevents", "quotes", "trades",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(
  code: WorkspaceParseErrorCode,
  path: string,
  message: string,
): typeof INVALID {
  errors.push({ code, path, message });
  return INVALID;
}

let errors: WorkspaceParseError[] = [];

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): boolean {
  let valid = true;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      fail("invalid-shape", `${path}.${key}`, "Prototype-related keys are not allowed.");
      valid = false;
    } else if (!allowedSet.has(key)) {
      fail("unknown-field", `${path}.${key}`, "This field is not part of workspace schema v1.");
      valid = false;
    }
  }
  return valid;
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseId(value: unknown, path: string): string | typeof INVALID {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    return fail("invalid-value", path, "Expected a canonical UUID.");
  }
  return value.toLowerCase();
}

function parseName(value: unknown, path: string): string | typeof INVALID {
  if (!isText(value, WORKSPACE_LIMITS.maxNameLength)) {
    return fail("invalid-value", path, `Expected non-empty text up to ${WORKSPACE_LIMITS.maxNameLength} characters.`);
  }
  return value.trim();
}

function parseSymbol(value: unknown, path: string): string | typeof INVALID {
  if (!isText(value, WORKSPACE_LIMITS.maxSymbolLength) || value !== value.trim() || value !== value.toUpperCase() ||
      !/^(?=.*[A-Z0-9])[A-Z0-9.\-^=&]{1,24}$/u.test(value)) {
    return fail("invalid-value", path, `Expected a bounded canonical symbol up to ${WORKSPACE_LIMITS.maxSymbolLength} characters.`);
  }
  return value;
}

function parseJsonValue(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): JsonValue | typeof INVALID {
  budget.nodes += 1;
  if (budget.nodes > 2048 || depth > 12) return fail("too-large", path, "Configuration is too deep or contains too many values.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fail("invalid-value", path, "Numbers must be finite.");
  }
  if (typeof value === "string") {
    return value.length <= 4096 ? value : fail("too-large", path, "Text value exceeds 4096 characters.");
  }
  if (Array.isArray(value)) {
    if (value.length > 256) return fail("too-large", path, "Array exceeds 256 items.");
    const result: JsonValue[] = [];
    let valid = true;
    value.forEach((item, index) => {
      const parsed = parseJsonValue(item, `${path}[${index}]`, depth + 1, budget);
      if (parsed === INVALID) valid = false;
      else result.push(parsed);
    });
    return valid ? result : INVALID;
  }
  if (!isRecord(value)) return fail("invalid-value", path, "Configuration must contain JSON-safe values only.");
  const keys = Object.keys(value);
  if (keys.length > 64) return fail("too-large", path, "Object exceeds 64 fields.");
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  let valid = true;
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      fail("invalid-shape", `${path}.${key}`, "Prototype-related keys are not allowed.");
      valid = false;
      continue;
    }
    if (FORBIDDEN_CONFIG_KEYS.has(key.toLowerCase())) {
      fail("invalid-shape", `${path}.${key}`, "Authentication, owner, account, order, and market-event data cannot be stored in workspace configuration.");
      valid = false;
      continue;
    }
    const parsed = parseJsonValue(value[key], `${path}.${key}`, depth + 1, budget);
    if (parsed === INVALID) valid = false;
    else result[key] = parsed;
  }
  return valid ? result : INVALID;
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength;
}

function parseWidget(value: unknown, path: string): WorkspaceWidgetInstanceV1 | typeof INVALID {
  const parsed = parseWidgetInstanceV1(value);
  if (!parsed.ok) {
    for (const issue of parsed.errors) {
      const code: WorkspaceParseErrorCode = issue.code === "too-large" ? "too-large" :
        issue.code === "unknown-field" ? "unknown-field" : "invalid-value";
      const issuePath = issue.path.startsWith("$") ? `${path}${issue.path.slice(1)}` : `${path}.${issue.path}`;
      fail(code, issuePath, issue.message);
    }
    return INVALID;
  }
  const config = parseJsonValue(parsed.value.config, `${path}.config`, 0, { nodes: 0 });
  if (config === INVALID) return INVALID;
  if (serializedBytes(config) > WORKSPACE_LIMITS.maxWidgetConfigBytes) {
    return fail("too-large", `${path}.config`, `Widget config exceeds ${WORKSPACE_LIMITS.maxWidgetConfigBytes} bytes.`);
  }
  return { ...parsed.value, config };
}

function parsePlacement(value: unknown, path: string): GridPlacementV1 | typeof INVALID {
  if (!isRecord(value)) return fail("invalid-shape", path, "Expected a grid placement object.");
  const keysValid = exactKeys(value, ["i", "x", "y", "w", "h"], path);
  const i = parseId(value.i, `${path}.i`);
  const numbers = [value.x, value.y, value.w, value.h];
  if (numbers.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))) {
    fail("invalid-value", path, "Grid coordinates and dimensions must be integers.");
    return INVALID;
  }
  const [x, y, w, h] = numbers as number[];
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > WORKSPACE_LIMITS.gridColumns || y + h > WORKSPACE_LIMITS.gridMaxRows) {
    fail("grid-out-of-bounds", path, "Placement exceeds the 12-column, 500-row grid.");
    return INVALID;
  }
  return keysValid && i !== INVALID ? { i, x, y, w, h } : INVALID;
}

function overlaps(left: GridPlacementV1, right: GridPlacementV1): boolean {
  return left.x < right.x + right.w && left.x + left.w > right.x &&
    left.y < right.y + right.h && left.y + left.h > right.y;
}

function parseTab(value: unknown, path: string): WorkspaceTabV1 | typeof INVALID {
  if (!isRecord(value)) return fail("invalid-shape", path, "Expected a workspace tab object.");
  const keysValid = exactKeys(value, ["id", "name", "widgets", "placements", "maximizedInstanceId"], path);
  const id = parseId(value.id, `${path}.id`);
  const name = parseName(value.name, `${path}.name`);
  if (!Array.isArray(value.widgets) || !Array.isArray(value.placements)) {
    return fail("invalid-shape", path, "Tab widgets and placements must be arrays.");
  }
  if (value.widgets.length > WORKSPACE_LIMITS.maxWidgetsPerTab || value.placements.length > WORKSPACE_LIMITS.maxWidgetsPerTab) {
    return fail("too-many-items", path, `A tab can contain at most ${WORKSPACE_LIMITS.maxWidgetsPerTab} widgets.`);
  }
  const widgets: WorkspaceWidgetInstanceV1[] = [];
  value.widgets.forEach((widget, index) => {
    const parsed = parseWidget(widget, `${path}.widgets[${index}]`);
    if (parsed !== INVALID) widgets.push(parsed);
  });
  const placements: GridPlacementV1[] = [];
  value.placements.forEach((placement, index) => {
    const parsed = parsePlacement(placement, `${path}.placements[${index}]`);
    if (parsed !== INVALID) placements.push(parsed);
  });
  const widgetIds = new Set<string>();
  for (const widget of widgets) {
    if (widgetIds.has(widget.instanceId)) fail("duplicate-id", `${path}.widgets`, "Widget instance IDs must be unique within a tab.");
    widgetIds.add(widget.instanceId);
  }
  const placementIds = new Set<string>();
  for (const placement of placements) {
    if (placementIds.has(placement.i)) fail("duplicate-id", `${path}.placements`, "Placement IDs must be unique.");
    placementIds.add(placement.i);
  }
  if (widgetIds.size !== placementIds.size || [...widgetIds].some((widgetId) => !placementIds.has(widgetId))) {
    fail("missing-reference", path, "Each widget must have exactly one grid placement.");
  }
  for (let left = 0; left < placements.length; left += 1) {
    for (let right = left + 1; right < placements.length; right += 1) {
      if (overlaps(placements[left], placements[right])) {
        fail("grid-overlap", `${path}.placements`, "Widget placements cannot overlap.");
        left = placements.length;
        break;
      }
    }
  }
  let maximizedInstanceId: string | null = null;
  if (value.maximizedInstanceId !== null) {
    maximizedInstanceId = parseId(value.maximizedInstanceId, `${path}.maximizedInstanceId`) as string | null;
    if (maximizedInstanceId !== INVALID && !widgetIds.has(maximizedInstanceId)) {
      fail("missing-reference", `${path}.maximizedInstanceId`, "Maximized widget must exist in this tab.");
    }
  }
  if (!keysValid || id === INVALID || name === INVALID || widgets.length !== value.widgets.length ||
      placements.length !== value.placements.length || maximizedInstanceId === INVALID) return INVALID;
  return { id, name, widgets, placements, maximizedInstanceId };
}

function parseMarketContext(value: unknown, path: string): WorkspaceMarketContextV1 | typeof INVALID {
  if (!isRecord(value)) return fail("invalid-shape", path, "Expected a market context object.");
  const keysValid = exactKeys(value, ["activeSymbol", "watchlist"], path);
  const activeSymbol = parseSymbol(value.activeSymbol, `${path}.activeSymbol`);
  if (!Array.isArray(value.watchlist)) return fail("invalid-shape", `${path}.watchlist`, "Watchlist must be an array.");
  if (value.watchlist.length > WORKSPACE_LIMITS.maxWatchlistSymbols) {
    return fail("too-many-items", `${path}.watchlist`, `Watchlist can contain at most ${WORKSPACE_LIMITS.maxWatchlistSymbols} symbols.`);
  }
  const watchlist: string[] = [];
  value.watchlist.forEach((symbol, index) => {
    const parsed = parseSymbol(symbol, `${path}.watchlist[${index}]`);
    if (parsed !== INVALID) watchlist.push(parsed);
  });
  if (new Set(watchlist.map((symbol) => symbol.toUpperCase())).size !== watchlist.length) {
    fail("duplicate-symbol", `${path}.watchlist`, "Watchlist symbols must be unique.");
  }
  if (!keysValid || activeSymbol === INVALID || watchlist.length !== value.watchlist.length) return INVALID;
  return { activeSymbol, watchlist };
}

function parseWorkspace(value: unknown, path: string): WorkspaceV1 | typeof INVALID {
  if (!isRecord(value)) return fail("invalid-shape", path, "Expected a workspace object.");
  const keysValid = exactKeys(value, ["id", "name", "activeTabId", "marketContext", "tabs"], path);
  const id = parseId(value.id, `${path}.id`);
  const name = parseName(value.name, `${path}.name`);
  const activeTabId = parseId(value.activeTabId, `${path}.activeTabId`);
  const marketContext = parseMarketContext(value.marketContext, `${path}.marketContext`);
  if (!Array.isArray(value.tabs)) return fail("invalid-shape", `${path}.tabs`, "Tabs must be an array.");
  if (value.tabs.length < 1 || value.tabs.length > WORKSPACE_LIMITS.maxTabsPerWorkspace) {
    return fail("too-many-items", `${path}.tabs`, `A workspace must contain 1-${WORKSPACE_LIMITS.maxTabsPerWorkspace} tabs.`);
  }
  const tabs: WorkspaceTabV1[] = [];
  value.tabs.forEach((tab, index) => {
    const parsed = parseTab(tab, `${path}.tabs[${index}]`);
    if (parsed !== INVALID) tabs.push(parsed);
  });
  const tabIds = new Set(tabs.map((tab) => tab.id));
  if (tabIds.size !== tabs.length) fail("duplicate-id", `${path}.tabs`, "Tab IDs must be unique within a workspace.");
  if (activeTabId !== INVALID && !tabIds.has(activeTabId)) {
    fail("missing-reference", `${path}.activeTabId`, "Active tab must exist in this workspace.");
  }
  if (!keysValid || id === INVALID || name === INVALID || activeTabId === INVALID || marketContext === INVALID || tabs.length !== value.tabs.length) return INVALID;
  return { id, name, activeTabId, marketContext, tabs };
}

function parseTemplate(value: unknown, path: string): WorkspaceTemplateV1 | typeof INVALID {
  if (!isRecord(value)) return fail("invalid-shape", path, "Expected a user template object.");
  const keysValid = exactKeys(value, ["id", "name", "marketContext", "tab"], path);
  const id = parseId(value.id, `${path}.id`);
  const name = parseName(value.name, `${path}.name`);
  const marketContext = parseMarketContext(value.marketContext, `${path}.marketContext`);
  const tab = parseTab(value.tab, `${path}.tab`);
  if (!keysValid || id === INVALID || name === INVALID || marketContext === INVALID || tab === INVALID) return INVALID;
  return { id, name, marketContext, tab };
}

function finish<T>(value: T): WorkspaceParseResult<T> {
  const collected = errors;
  errors = [];
  return collected.length === 0
    ? { ok: true, value }
    : { ok: false, errors: collected };
}

/** Strict structural parser shared by the browser repository and server route. */
export function parseWorkspaceDocument(input: unknown): WorkspaceParseResult<WorkspaceDocumentV1> {
  errors = [];
  if (!isRecord(input)) return finish(fail("invalid-shape", "$", "Expected a workspace document object.") as never);
  if (input.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    return finish(fail("unsupported-version", "$.schemaVersion", "Only workspace schema version 1 is supported.") as never);
  }
  const keysValid = exactKeys(input, ["schemaVersion", "activeWorkspaceId", "workspaces", "userTemplates"], "$");
  const activeWorkspaceId = parseId(input.activeWorkspaceId, "$.activeWorkspaceId");
  if (!Array.isArray(input.workspaces)) return finish(fail("invalid-shape", "$.workspaces", "Workspaces must be an array.") as never);
  if (input.workspaces.length < 1 || input.workspaces.length > WORKSPACE_LIMITS.maxWorkspaces) {
    return finish(fail("too-many-items", "$.workspaces", `A document must contain 1-${WORKSPACE_LIMITS.maxWorkspaces} workspaces.`) as never);
  }
  const workspaces: WorkspaceV1[] = [];
  input.workspaces.forEach((workspace, index) => {
    const parsed = parseWorkspace(workspace, `$.workspaces[${index}]`);
    if (parsed !== INVALID) workspaces.push(parsed);
  });
  if (!Array.isArray(input.userTemplates)) return finish(fail("invalid-shape", "$.userTemplates", "User templates must be an array.") as never);
  if (input.userTemplates.length > WORKSPACE_LIMITS.maxUserTemplates) {
    return finish(fail("too-many-items", "$.userTemplates", `At most ${WORKSPACE_LIMITS.maxUserTemplates} user templates are allowed.`) as never);
  }
  const userTemplates: WorkspaceTemplateV1[] = [];
  input.userTemplates.forEach((template, index) => {
    const parsed = parseTemplate(template, `$.userTemplates[${index}]`);
    if (parsed !== INVALID) userTemplates.push(parsed);
  });
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  if (workspaceIds.size !== workspaces.length) fail("duplicate-id", "$.workspaces", "Workspace IDs must be unique.");
  if (activeWorkspaceId !== INVALID && !workspaceIds.has(activeWorkspaceId)) {
    fail("missing-reference", "$.activeWorkspaceId", "Active workspace must exist in the document.");
  }
  const templateIds = new Set(userTemplates.map((template) => template.id));
  if (templateIds.size !== userTemplates.length) fail("duplicate-id", "$.userTemplates", "Template IDs must be unique.");
  const allIds = new Set<string>();
  const registerId = (id: string, path: string) => {
    if (allIds.has(id)) fail("duplicate-id", path, "Workspace, tab, widget, and template IDs must be unique across the document.");
    allIds.add(id);
  };
  for (const workspace of workspaces) {
    registerId(workspace.id, "$.workspaces");
    for (const tab of workspace.tabs) {
      registerId(tab.id, "$.workspaces.tabs");
      for (const widget of tab.widgets) registerId(widget.instanceId, "$.workspaces.tabs.widgets");
    }
  }
  for (const template of userTemplates) {
    registerId(template.id, "$.userTemplates");
    registerId(template.tab.id, "$.userTemplates.tab");
    for (const widget of template.tab.widgets) registerId(widget.instanceId, "$.userTemplates.tab.widgets");
  }
  if (!keysValid || activeWorkspaceId === INVALID || workspaces.length !== input.workspaces.length || userTemplates.length !== input.userTemplates.length) {
    return finish(INVALID as never);
  }
  const document: WorkspaceDocumentV1 = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkspaceId,
    workspaces,
    userTemplates,
  };
  if (serializedBytes(document) > WORKSPACE_LIMITS.maxDocumentBytes) {
    fail("too-large", "$", `Workspace document exceeds ${WORKSPACE_LIMITS.maxDocumentBytes} bytes.`);
    return finish(INVALID as never);
  }
  return finish(document);
}

export function parseWorkspaceJson(text: string): WorkspaceParseResult<WorkspaceDocumentV1> {
  if (new TextEncoder().encode(text).byteLength > WORKSPACE_LIMITS.maxDocumentBytes) {
    errors = [];
    return finish(fail("too-large", "$", `Workspace document exceeds ${WORKSPACE_LIMITS.maxDocumentBytes} bytes.`) as never);
  }
  try {
    return parseWorkspaceDocument(JSON.parse(text) as unknown);
  } catch {
    errors = [];
    return finish(fail("invalid-json", "$", "The workspace file is not valid JSON.") as never);
  }
}

export function parseWorkspaceExport(input: unknown): WorkspaceParseResult<WorkspaceExportV1> {
  errors = [];
  if (!isRecord(input)) return finish(fail("invalid-shape", "$", "Expected an export envelope.") as never);
  const keysValid = exactKeys(input, ["format", "schemaVersion", "document"], "$");
  if (input.schemaVersion !== WORKSPACE_SCHEMA_VERSION || input.format !== WORKSPACE_EXPORT_FORMAT) {
    return finish(fail("unsupported-version", "$", "Only eqoboard.workspace-export schema version 1 is supported.") as never);
  }
  const envelopeErrors = [...errors];
  const parsed = parseWorkspaceDocument(input.document);
  errors = envelopeErrors;
  if (!parsed.ok) {
    errors.push(...parsed.errors);
    return finish(INVALID as never);
  }
  if (!keysValid) return finish(INVALID as never);
  return finish({ format: WORKSPACE_EXPORT_FORMAT, schemaVersion: WORKSPACE_SCHEMA_VERSION, document: parsed.value });
}

export function parseWorkspaceExportJson(text: string): WorkspaceParseResult<WorkspaceExportV1> {
  if (new TextEncoder().encode(text).byteLength > WORKSPACE_LIMITS.maxDocumentBytes + 1024) {
    errors = [];
    return finish(fail("too-large", "$", "Workspace export exceeds its size limit.") as never);
  }
  try {
    return parseWorkspaceExport(JSON.parse(text) as unknown);
  } catch {
    errors = [];
    return finish(fail("invalid-json", "$", "The workspace export is not valid JSON.") as never);
  }
}

export function createWorkspaceExport(document: WorkspaceDocumentV1): WorkspaceExportV1 {
  const parsed = parseWorkspaceDocument(document);
  if (!parsed.ok) throw new TypeError("Cannot export an invalid workspace document.");
  return { format: WORKSPACE_EXPORT_FORMAT, schemaVersion: WORKSPACE_SCHEMA_VERSION, document: parsed.value };
}

