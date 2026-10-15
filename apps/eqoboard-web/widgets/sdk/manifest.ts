import { isPermission, PERMISSIONS, type Permission } from "../../lib/contracts/auth";
import {
  WIDGET_SDK_VERSION,
  type WidgetCategory,
  type WidgetInputV1,
  type WidgetInstanceV1,
  type WidgetJsonValueV1,
  type WidgetManifestV1,
  type WidgetParseResult,
  type WidgetRefreshPolicyV1,
  type WidgetShortcut,
  type WidgetSymbolBinding,
  type WidgetValidationErrorCode,
  type WidgetValidationIssue,
} from "./contracts";
import { isWidgetSymbol } from "./symbols";

export const WIDGET_SCHEMA_LIMITS = Object.freeze({
  maxManifestBytes: 16 * 1024,
  maxConfigBytes: 8 * 1024,
  maxConfigDepth: 12,
  maxConfigNodes: 2048,
  maxObjectFields: 64,
  maxArrayItems: 256,
  maxTextLength: 4096,
  maxInputs: 8,
  gridColumns: 12,
});

const INVALID = Symbol("invalid-widget-data");
const MANIFEST_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const CONFIG_SCHEMA_ID = /^[a-z][a-z0-9.-]*\.v[1-9]\d*$/u;
const RENDERER_ID = /^[a-z][a-z0-9.-]{1,95}$/u;
const PROVENANCE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CATEGORIES = new Set<WidgetCategory>(["market", "research", "portfolio", "utility"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type IssueCollector = { issues: WidgetValidationIssue[] };

function issue(
  collector: IssueCollector,
  code: WidgetValidationErrorCode,
  path: string,
  message: string,
): void {
  collector.issues.push({ code, path: path.slice(0, 160), message });
}

/** Read plain data records without invoking getters; malformed proxies fail closed. */
function readRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > WIDGET_SCHEMA_LIMITS.maxObjectFields || ownKeys.some((key) => typeof key !== "string")) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function readArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > WIDGET_SCHEMA_LIMITS.maxArrayItems) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > WIDGET_SCHEMA_LIMITS.maxArrayItems + 1) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) return null;
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
  }
  if (ownKeys.length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  collector: IssueCollector,
  optional: readonly string[] = [],
): boolean {
  const allowedKeys = new Set(allowed);
  const optionalKeys = new Set(optional);
  let valid = true;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      issue(collector, "invalid-shape", `${path}.*`, "Prototype-related keys are not allowed.");
      valid = false;
    } else if (!allowedKeys.has(key)) {
      issue(collector, "unknown-field", `${path}.*`, "This field is not part of widget schema v1.");
      valid = false;
    }
  }
  for (const key of allowed) {
    if (!optionalKeys.has(key) && !Object.hasOwn(value, key)) {
      issue(collector, "invalid-shape", `${path}.${key}`, "Required field is missing.");
      valid = false;
    }
  }
  return valid;
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !CONTROL.test(value);
}

function finiteInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parseJsonValue(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
  collector: IssueCollector,
): WidgetJsonValueV1 | typeof INVALID {
  budget.nodes += 1;
  if (budget.nodes > WIDGET_SCHEMA_LIMITS.maxConfigNodes || depth > WIDGET_SCHEMA_LIMITS.maxConfigDepth) {
    issue(collector, "too-large", path, "Configuration is too deep or contains too many values.");
    return INVALID;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    issue(collector, "invalid-value", path, "Numbers must be finite.");
    return INVALID;
  }
  if (typeof value === "string") {
    if (value.length <= WIDGET_SCHEMA_LIMITS.maxTextLength && !CONTROL.test(value)) return value;
    issue(collector, "too-large", path, "Text value is too long or contains control characters.");
    return INVALID;
  }
  const array = readArray(value);
  if (array) {
    if (array.length > WIDGET_SCHEMA_LIMITS.maxArrayItems) {
      issue(collector, "too-large", path, "Array exceeds its size limit.");
      return INVALID;
    }
    const parsed: WidgetJsonValueV1[] = [];
    let valid = true;
    array.forEach((item, index) => {
      const child = parseJsonValue(item, `${path}[${index}]`, depth + 1, budget, collector);
      if (child === INVALID) valid = false;
      else parsed.push(child);
    });
    return valid ? Object.freeze(parsed) : INVALID;
  }
  const record = readRecord(value);
  if (!record) {
    issue(collector, "invalid-value", path, "Configuration must contain plain JSON data only.");
    return INVALID;
  }
  const keys = Object.keys(record);
  if (keys.length > WIDGET_SCHEMA_LIMITS.maxObjectFields) {
    issue(collector, "too-large", path, "Object exceeds its field limit.");
    return INVALID;
  }
  const parsed: Record<string, WidgetJsonValueV1> = Object.create(null) as Record<string, WidgetJsonValueV1>;
  let valid = true;
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key) || key.length > 128 || CONTROL.test(key)) {
      issue(collector, "invalid-shape", `${path}.*`, "Configuration contains an invalid field name.");
      valid = false;
      continue;
    }
    const child = parseJsonValue(record[key], `${path}.${key}`, depth + 1, budget, collector);
    if (child === INVALID) valid = false;
    else parsed[key] = child;
  }
  return valid ? Object.freeze(parsed) : INVALID;
}

function configData(
  value: unknown,
  path: string,
  collector: IssueCollector,
): WidgetJsonValueV1 | typeof INVALID {
  const parsed = parseJsonValue(value, path, 0, { nodes: 0 }, collector);
  if (parsed !== INVALID && bytes(parsed) > WIDGET_SCHEMA_LIMITS.maxConfigBytes) {
    issue(collector, "too-large", path, `Configuration exceeds ${WIDGET_SCHEMA_LIMITS.maxConfigBytes} bytes.`);
    return INVALID;
  }
  return parsed;
}

function parseInput(value: unknown, path: string, collector: IssueCollector): WidgetInputV1 | typeof INVALID {
  const record = readRecord(value);
  if (!record) {
    issue(collector, "invalid-shape", path, "Expected a widget input declaration.");
    return INVALID;
  }
  if (record.name === "symbol") {
    const valid = exactKeys(record, ["name", "kind", "source", "required"], path, collector);
    if (record.kind !== "symbol" || record.source !== "symbol-binding" || record.required !== true) {
      issue(collector, "invalid-value", path, "Symbol input declaration is invalid.");
      return INVALID;
    }
    return valid ? Object.freeze({ name: "symbol", kind: "symbol", source: "symbol-binding", required: true }) : INVALID;
  }
  if (record.name === "watchlist") {
    const valid = exactKeys(record, ["name", "kind", "source", "required"], path, collector);
    if (record.kind !== "symbol-list" || record.source !== "workspace.watchlist" || record.required !== true) {
      issue(collector, "invalid-value", path, "Watchlist input declaration is invalid.");
      return INVALID;
    }
    return valid ? Object.freeze({ name: "watchlist", kind: "symbol-list", source: "workspace.watchlist", required: true }) : INVALID;
  }
  issue(collector, "invalid-value", `${path}.name`, "Input name is unsupported.");
  return INVALID;
}

function parseSize(value: unknown, collector: IssueCollector): WidgetManifestV1["defaultSize"] | typeof INVALID {
  const path = "$.defaultSize";
  const record = readRecord(value);
  if (!record) {
    issue(collector, "invalid-shape", path, "Expected bounded default widget dimensions.");
    return INVALID;
  }
  const validKeys = exactKeys(record, ["w", "h", "minW", "minH", "maxW", "maxH"], path, collector);
  const fields = [record.w, record.h, record.minW, record.minH, record.maxW, record.maxH];
  if (fields.some((field) => !finiteInteger(field, 1, 500))) {
    issue(collector, "invalid-value", path, "Widget dimensions must be positive bounded integers.");
    return INVALID;
  }
  const [w, h, minW, minH, maxW, maxH] = fields as number[];
  if (maxW > WIDGET_SCHEMA_LIMITS.gridColumns || minW > w || w > maxW || minH > h || h > maxH) {
    issue(collector, "invalid-value", path, "Default dimensions must satisfy their bounds and the 12-column grid.");
    return INVALID;
  }
  return validKeys ? { w, h, minW, minH, maxW, maxH } : INVALID;
}

function parseRefresh(value: unknown, collector: IssueCollector): WidgetRefreshPolicyV1 | typeof INVALID {
  const path = "$.refresh";
  const record = readRecord(value);
  if (!record || typeof record.mode !== "string") {
    issue(collector, "invalid-shape", path, "Expected a refresh policy.");
    return INVALID;
  }
  if (record.mode === "none" || record.mode === "shared-market") {
    const valid = exactKeys(record, ["mode"], path, collector);
    return valid ? { mode: record.mode } : INVALID;
  }
  if (record.mode !== "poll") {
    issue(collector, "invalid-value", `${path}.mode`, "Refresh mode is unsupported.");
    return INVALID;
  }
  const validKeys = exactKeys(record, [
    "mode", "minIntervalMs", "maxRequestsPerMinute", "maxConcurrentRequests", "whenHidden",
  ], path, collector);
  if (!finiteInteger(record.minIntervalMs, 250, 3_600_000) ||
      !finiteInteger(record.maxRequestsPerMinute, 1, 120) ||
      record.maxConcurrentRequests !== 1 ||
      (record.whenHidden !== "pause" && record.whenHidden !== "continue")) {
    issue(collector, "invalid-value", path, "Polling values exceed the bounded V1 policy.");
    return INVALID;
  }
  return validKeys ? {
    mode: "poll",
    minIntervalMs: record.minIntervalMs as number,
    maxRequestsPerMinute: record.maxRequestsPerMinute as number,
    maxConcurrentRequests: 1,
    whenHidden: record.whenHidden,
  } : INVALID;
}

function parseSymbolBinding(value: unknown, path: string, collector: IssueCollector): WidgetSymbolBinding | typeof INVALID {
  const record = readRecord(value);
  if (!record || typeof record.mode !== "string") {
    issue(collector, "invalid-shape", path, "Expected a symbol binding.");
    return INVALID;
  }
  if (record.mode === "active") {
    return exactKeys(record, ["mode"], path, collector) ? Object.freeze({ mode: "active" }) : INVALID;
  }
  if (record.mode === "fixed") {
    const validKeys = exactKeys(record, ["mode", "symbol"], path, collector);
    if (!isWidgetSymbol(record.symbol)) {
      issue(collector, "invalid-value", `${path}.symbol`, "Expected a bounded canonical symbol.");
      return INVALID;
    }
    return validKeys ? Object.freeze({ mode: "fixed", symbol: record.symbol as string }) : INVALID;
  }
  issue(collector, "invalid-value", `${path}.mode`, "Symbol binding mode is unsupported.");
  return INVALID;
}

function parseManifest(input: unknown, collector: IssueCollector): WidgetManifestV1 | typeof INVALID {
  const value = readRecord(input);
  if (!value) {
    issue(collector, "invalid-shape", "$", "Expected a plain widget manifest object.");
    return INVALID;
  }
  if (value.manifestVersion !== 1 || value.sdkVersion !== WIDGET_SDK_VERSION) {
    issue(collector, "unsupported-version", "$", "Only manifest and SDK version 1 are supported.");
    return INVALID;
  }
  const optionalKeys = ["shortcut"] as const;
  const requiredKeys = [
    "manifestVersion", "sdkVersion", "id", "version", "title", "description", "category",
    "rendererId", "configSchemaId", "defaultSize", "inputs", "requiredPermissions", "refresh",
    "symbolBinding", "provenanceId", "provenancePolicy",
  ];
  const validKeys = exactKeys(value, [...requiredKeys, ...optionalKeys], "$", collector, optionalKeys);
  let valid = validKeys;

  if (typeof value.id !== "string" || !MANIFEST_ID.test(value.id)) {
    issue(collector, "invalid-value", "$.id", "Expected a static namespaced widget identifier.");
    valid = false;
  }
  if (typeof value.version !== "string" || !VERSION.test(value.version)) {
    issue(collector, "invalid-value", "$.version", "Expected a semantic widget version.");
    valid = false;
  }
  if (!text(value.title, 80)) {
    issue(collector, "invalid-value", "$.title", "Expected a non-empty bounded title.");
    valid = false;
  }
  if (typeof value.description !== "string" || value.description.length > 280 || CONTROL.test(value.description)) {
    issue(collector, "invalid-value", "$.description", "Description exceeds its bounded text limit.");
    valid = false;
  }
  if (typeof value.category !== "string" || !CATEGORIES.has(value.category as WidgetCategory)) {
    issue(collector, "invalid-value", "$.category", "Widget category is unsupported.");
    valid = false;
  }
  if (typeof value.rendererId !== "string" || !RENDERER_ID.test(value.rendererId)) {
    issue(collector, "invalid-value", "$.rendererId", "Expected a static renderer identifier, not a module path.");
    valid = false;
  }
  if (typeof value.configSchemaId !== "string" || !CONFIG_SCHEMA_ID.test(value.configSchemaId)) {
    issue(collector, "invalid-value", "$.configSchemaId", "Expected a versioned static config schema identifier.");
    valid = false;
  }
  if (typeof value.provenanceId !== "string" || !PROVENANCE_ID.test(value.provenanceId)) {
    issue(collector, "invalid-value", "$.provenanceId", "Expected a bounded provenance record identifier.");
    valid = false;
  }
  if (value.symbolBinding !== "unsupported" && value.symbolBinding !== "active-or-fixed") {
    issue(collector, "invalid-value", "$.symbolBinding", "Symbol binding declaration is unsupported.");
    valid = false;
  }
  if (value.provenancePolicy !== "surface-response-evidence" && value.provenancePolicy !== "no-market-data") {
    issue(collector, "invalid-value", "$.provenancePolicy", "Provenance display policy is unsupported.");
    valid = false;
  }

  const defaultSize = parseSize(value.defaultSize, collector);
  if (defaultSize === INVALID) valid = false;

  const rawInputs = readArray(value.inputs);
  const inputs: WidgetInputV1[] = [];
  if (!rawInputs || rawInputs.length > WIDGET_SCHEMA_LIMITS.maxInputs) {
    issue(collector, "too-large", "$.inputs", "Expected a bounded list of widget inputs.");
    valid = false;
  } else {
    rawInputs.forEach((entry, index) => {
      const parsed = parseInput(entry, `$.inputs[${index}]`, collector);
      if (parsed === INVALID) valid = false;
      else inputs.push(parsed);
    });
    if (new Set(inputs.map((entry) => entry.name)).size !== inputs.length) {
      issue(collector, "duplicate-value", "$.inputs", "Input names must be unique.");
      valid = false;
    }
  }
  if (inputs.some((entry) => entry.name === "symbol") && value.symbolBinding !== "active-or-fixed") {
    issue(collector, "invalid-value", "$.symbolBinding", "A symbol input requires declared symbol binding support.");
    valid = false;
  }

  const rawPermissions = readArray(value.requiredPermissions);
  const permissions: Permission[] = [];
  if (!rawPermissions || rawPermissions.length > PERMISSIONS.length) {
    issue(collector, "too-large", "$.requiredPermissions", "Expected a bounded permission list.");
    valid = false;
  } else {
    rawPermissions.forEach((permission, index) => {
      if (!isPermission(permission)) {
        issue(collector, "unknown-permission", `$.requiredPermissions[${index}]`, "Permission is not in the closed auth contract.");
        valid = false;
      } else {
        permissions.push(permission);
      }
    });
    if (new Set(permissions).size !== permissions.length) {
      issue(collector, "duplicate-value", "$.requiredPermissions", "Permissions must be unique.");
      valid = false;
    }
  }

  const refresh = parseRefresh(value.refresh, collector);
  if (refresh === INVALID) valid = false;
  if (value.provenancePolicy === "no-market-data" &&
      (refresh !== INVALID && refresh.mode !== "none" || inputs.length !== 0)) {
    issue(collector, "invalid-value", "$.provenancePolicy", "Widgets without market data cannot declare data inputs or refresh work.");
    valid = false;
  }

  let shortcut: WidgetShortcut | undefined;
  if (Object.hasOwn(value, "shortcut")) {
    if (typeof value.shortcut !== "string" || !/^Alt\+[1-9]$/u.test(value.shortcut)) {
      issue(collector, "invalid-value", "$.shortcut", "Shortcut must be Alt+1 through Alt+9.");
      valid = false;
    } else {
      shortcut = value.shortcut as WidgetShortcut;
    }
  }

  if (!valid || defaultSize === INVALID || refresh === INVALID) return INVALID;
  const manifest: WidgetManifestV1 = {
    manifestVersion: 1,
    sdkVersion: 1,
    id: value.id as string,
    version: value.version as string,
    title: value.title as string,
    description: value.description as string,
    category: value.category as WidgetCategory,
    rendererId: value.rendererId as string,
    configSchemaId: value.configSchemaId as string,
    defaultSize,
    inputs,
    requiredPermissions: permissions,
    refresh,
    symbolBinding: value.symbolBinding as WidgetManifestV1["symbolBinding"],
    provenanceId: value.provenanceId as string,
    provenancePolicy: value.provenancePolicy as WidgetManifestV1["provenancePolicy"],
    ...(shortcut ? { shortcut } : {}),
  };
  if (bytes(manifest) > WIDGET_SCHEMA_LIMITS.maxManifestBytes) {
    issue(collector, "too-large", "$", "Manifest exceeds the V1 size limit.");
    return INVALID;
  }
  return freezeManifest(manifest);
}

function freezeManifest(manifest: WidgetManifestV1): WidgetManifestV1 {
  Object.freeze(manifest.defaultSize);
  manifest.inputs.forEach(Object.freeze);
  Object.freeze(manifest.inputs);
  Object.freeze(manifest.requiredPermissions);
  Object.freeze(manifest.refresh);
  return Object.freeze(manifest);
}

function runParser<T>(parse: (collector: IssueCollector) => T | typeof INVALID): WidgetParseResult<T> {
  const collector: IssueCollector = { issues: [] };
  try {
    const value = parse(collector);
    return value === INVALID || collector.issues.length > 0
      ? { ok: false, errors: collector.issues }
      : { ok: true, value };
  } catch {
    return {
      ok: false,
      errors: [{ code: "invalid-shape", path: "$", message: "Input could not be safely inspected." }],
    };
  }
}

/** Runtime validator for data-only builtin manifests; unknown keys fail closed. */
export function parseWidgetManifestV1(input: unknown): WidgetParseResult<WidgetManifestV1> {
  return runParser((collector) => parseManifest(input, collector));
}

/** Structural persisted-instance validation; it intentionally does not resolve a registry entry. */
export function parseWidgetInstanceV1(input: unknown): WidgetParseResult<WidgetInstanceV1> {
  return runParser((collector) => {
    const value = readRecord(input);
    if (!value) {
      issue(collector, "invalid-shape", "$", "Expected a plain widget instance object.");
      return INVALID;
    }
    const keysValid = exactKeys(
      value,
      ["instanceId", "manifestId", "manifestVersion", "configSchemaId", "config", "symbolBinding"],
      "$",
      collector,
      ["symbolBinding"],
    );
    let valid = keysValid;
    if (typeof value.instanceId !== "string" || !INSTANCE_ID.test(value.instanceId)) {
      issue(collector, "invalid-value", "$.instanceId", "Expected a canonical UUID.");
      valid = false;
    }
    if (typeof value.manifestId !== "string" || !MANIFEST_ID.test(value.manifestId)) {
      issue(collector, "invalid-value", "$.manifestId", "Expected a static namespaced manifest identifier.");
      valid = false;
    }
    if (typeof value.manifestVersion !== "string" || !VERSION.test(value.manifestVersion)) {
      issue(collector, "invalid-value", "$.manifestVersion", "Expected a semantic manifest version.");
      valid = false;
    }
    if (typeof value.configSchemaId !== "string" || !CONFIG_SCHEMA_ID.test(value.configSchemaId)) {
      issue(collector, "invalid-value", "$.configSchemaId", "Expected a versioned static config schema identifier.");
      valid = false;
    }
    const config = configData(value.config, "$.config", collector);
    if (config === INVALID) valid = false;
    let symbolBinding: WidgetSymbolBinding | undefined;
    if (Object.hasOwn(value, "symbolBinding")) {
      symbolBinding = parseSymbolBinding(value.symbolBinding, "$.symbolBinding", collector) as WidgetSymbolBinding | undefined;
      if (!symbolBinding) valid = false;
    }
    if (!valid || config === INVALID) return INVALID;
    const instance: WidgetInstanceV1 = {
      instanceId: value.instanceId as string,
      manifestId: value.manifestId as string,
      manifestVersion: value.manifestVersion as string,
      configSchemaId: value.configSchemaId as string,
      config,
      ...(symbolBinding ? { symbolBinding } : {}),
    };
    if (bytes(instance) > WIDGET_SCHEMA_LIMITS.maxConfigBytes + 2_048) {
      issue(collector, "too-large", "$", "Widget instance exceeds its size limit.");
      return INVALID;
    }
    if (symbolBinding) Object.freeze(symbolBinding);
    return Object.freeze(instance);
  });
}

/** Bounded JSON-safe structural parse used before a registration-specific config parser. */
export function parseWidgetConfigData(input: unknown): WidgetParseResult<WidgetJsonValueV1> {
  return runParser((collector) => configData(input, "$", collector));
}
