import { hasControlCharacters } from "./text";

/**
 * Bounded, versioned saved-query intent for native Research widgets.
 * This is workspace UI configuration, not a market or provider wire contract.
 */

export const RESEARCH_QUERY_CONFIG_SCHEMA_ID = "research.saved-queries.v1" as const;
export const RESEARCH_QUERY_CONFIG_VERSION = 1 as const;
export const RESEARCH_QUERY_LIMITS = Object.freeze({
  maxSavedQueries: 12,
  maxFiltersPerQuery: 8,
  maxCompareQueries: 2,
  maxNameLength: 48,
  maxFilterValueLength: 96,
  maxSerializedBytes: 8 * 1024,
});

export const RESEARCH_VIEW_IDS = [
  "news",
  "macro-us",
  "macro-eu",
  "economic-calendar",
  "earnings-calendar",
  "earnings-history",
  "insider",
  "screener-us",
  "screener-eu",
  "heatmap-us",
  "heatmap-eu",
  "crypto",
  "crypto-global",
] as const;

export type ResearchViewId = (typeof RESEARCH_VIEW_IDS)[number];
export type ResearchFilterOperator = "contains" | "equals";

/** Filter fields are allowlisted per native view; arbitrary keys never reach a data adapter. */
export const RESEARCH_FILTER_FIELDS = Object.freeze({
  news: ["title", "publisher", "symbol"] as const,
  "macro-us": ["id", "label", "provider", "asOf", "symbol", "source"] as const,
  "macro-eu": ["id", "label", "provider", "asOf", "symbol", "source"] as const,
  "economic-calendar": ["title", "country", "scheduledAt", "impact"] as const,
  "earnings-calendar": ["symbol", "source"] as const,
  "earnings-history": ["fiscalQuarterEnd", "reportedAt", "priceMoveSource"] as const,
  insider: ["filingDate", "transactionDate", "ownerName", "ownerTitle", "transactionCode"] as const,
  "screener-us": [
    "symbol",
    "name",
    "sector",
    "exchange",
    "priceSource",
    "marketCapSource",
  ] as const,
  "screener-eu": [
    "symbol",
    "name",
    "sector",
    "exchange",
    "priceSource",
    "marketCapSource",
  ] as const,
  "heatmap-us": ["symbol", "name", "sector", "exchange", "priceSource", "marketCapSource"] as const,
  "heatmap-eu": ["symbol", "name", "sector", "exchange", "priceSource", "marketCapSource"] as const,
  crypto: ["symbol", "name", "id"] as const,
  "crypto-global": ["provider"] as const,
} satisfies Record<ResearchViewId, readonly string[]>);

export type ResearchFilterField = {
  [View in ResearchViewId]: (typeof RESEARCH_FILTER_FIELDS)[View][number];
}[ResearchViewId];

export type ResearchFilterV1 = Readonly<{
  field: ResearchFilterField;
  operator: ResearchFilterOperator;
  value: string;
}>;

export type SavedResearchQueryV1 = Readonly<{
  id: string;
  name: string;
  viewId: ResearchViewId;
  filters: readonly ResearchFilterV1[];
}>;

export type ResearchQueryConfigV1 = Readonly<{
  schemaVersion: typeof RESEARCH_QUERY_CONFIG_VERSION;
  queries: readonly SavedResearchQueryV1[];
  selectedQueryId: string | null;
  compareQueryIds: readonly string[];
}>;

export type ResearchQueryConfigError = Readonly<{
  path: string;
  code:
    | "invalid-shape"
    | "unknown-field"
    | "invalid-value"
    | "too-large"
    | "duplicate-id"
    | "invalid-reference";
}>;

export type ResearchQueryConfigResult =
  | Readonly<{ ok: true; value: ResearchQueryConfigV1 }>
  | Readonly<{ ok: false; errors: readonly ResearchQueryConfigError[] }>;

const QUERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).every((key) => keys.includes(key) && !FORBIDDEN_KEYS.has(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isViewId(value: unknown): value is ResearchViewId {
  return typeof value === "string" && (RESEARCH_VIEW_IDS as readonly string[]).includes(value);
}

function fieldsForView(viewId: ResearchViewId): readonly string[] {
  return RESEARCH_FILTER_FIELDS[viewId];
}

/** Strict parser suitable for untrusted widget config read from workspace storage. */
export function parseResearchQueryConfig(input: unknown): ResearchQueryConfigResult {
  const errors: ResearchQueryConfigError[] = [];
  const reject = (path: string, code: ResearchQueryConfigError["code"]): void => {
    errors.push({ path, code });
  };

  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "$", code: "invalid-shape" }] };
  }
  if (!hasExactKeys(input, ["schemaVersion", "queries", "selectedQueryId", "compareQueryIds"])) {
    const allowed = new Set(["schemaVersion", "queries", "selectedQueryId", "compareQueryIds"]);
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) reject(`$.${key}`, "unknown-field");
    }
    if (
      ["schemaVersion", "queries", "selectedQueryId", "compareQueryIds"].some(
        (key) => !Object.hasOwn(input, key),
      )
    ) {
      reject("$", "invalid-shape");
    }
  }
  if (input.schemaVersion !== RESEARCH_QUERY_CONFIG_VERSION)
    reject("$.schemaVersion", "invalid-value");
  if (
    !Array.isArray(input.queries) ||
    input.queries.length > RESEARCH_QUERY_LIMITS.maxSavedQueries
  ) {
    reject("$.queries", "too-large");
  }
  if (
    !Array.isArray(input.compareQueryIds) ||
    input.compareQueryIds.length > RESEARCH_QUERY_LIMITS.maxCompareQueries
  ) {
    reject("$.compareQueryIds", "too-large");
  }
  if (
    input.selectedQueryId !== null &&
    (typeof input.selectedQueryId !== "string" || !QUERY_ID.test(input.selectedQueryId))
  ) {
    reject("$.selectedQueryId", "invalid-value");
  }
  const selectedQueryIdInput = input.selectedQueryId;
  const selectedQueryId =
    typeof selectedQueryIdInput === "string" && QUERY_ID.test(selectedQueryIdInput)
      ? selectedQueryIdInput.toLowerCase()
      : null;

  const queries: SavedResearchQueryV1[] = [];
  if (
    Array.isArray(input.queries) &&
    input.queries.length <= RESEARCH_QUERY_LIMITS.maxSavedQueries
  ) {
    input.queries.forEach((raw, index) => {
      const path = `$.queries[${index}]`;
      if (!isRecord(raw) || !hasExactKeys(raw, ["id", "name", "viewId", "filters"])) {
        reject(path, "invalid-shape");
        return;
      }
      if (typeof raw.id !== "string" || !QUERY_ID.test(raw.id))
        reject(`${path}.id`, "invalid-value");
      if (
        typeof raw.name !== "string" ||
        raw.name.trim() === "" ||
        raw.name.trim() !== raw.name ||
        raw.name.length > RESEARCH_QUERY_LIMITS.maxNameLength ||
        hasControlCharacters(raw.name)
      ) {
        reject(`${path}.name`, "invalid-value");
      }
      if (!isViewId(raw.viewId)) reject(`${path}.viewId`, "invalid-value");
      if (
        !Array.isArray(raw.filters) ||
        raw.filters.length > RESEARCH_QUERY_LIMITS.maxFiltersPerQuery
      ) {
        reject(`${path}.filters`, "too-large");
      }

      const viewId = isViewId(raw.viewId) ? raw.viewId : null;
      const id = raw.id;
      const filters: ResearchFilterV1[] = [];
      if (
        Array.isArray(raw.filters) &&
        raw.filters.length <= RESEARCH_QUERY_LIMITS.maxFiltersPerQuery
      ) {
        const seenFields = new Set<string>();
        raw.filters.forEach((filter, filterIndex) => {
          const filterPath = `${path}.filters[${filterIndex}]`;
          if (!isRecord(filter) || !hasExactKeys(filter, ["field", "operator", "value"])) {
            reject(filterPath, "invalid-shape");
            return;
          }
          const fieldIsValid =
            typeof filter.field === "string" &&
            viewId !== null &&
            fieldsForView(viewId).includes(filter.field);
          if (!fieldIsValid) reject(`${filterPath}.field`, "invalid-value");
          if (filter.operator !== "contains" && filter.operator !== "equals") {
            reject(`${filterPath}.operator`, "invalid-value");
          }
          if (
            typeof filter.value !== "string" ||
            filter.value.trim() === "" ||
            filter.value.length > RESEARCH_QUERY_LIMITS.maxFilterValueLength ||
            hasControlCharacters(filter.value)
          ) {
            reject(`${filterPath}.value`, "invalid-value");
          }
          if (typeof filter.field === "string") {
            if (seenFields.has(filter.field)) reject(`${filterPath}.field`, "invalid-value");
            seenFields.add(filter.field);
          }
          if (
            fieldIsValid &&
            (filter.operator === "contains" || filter.operator === "equals") &&
            typeof filter.value === "string" &&
            filter.value.trim() !== "" &&
            filter.value.length <= RESEARCH_QUERY_LIMITS.maxFilterValueLength &&
            !hasControlCharacters(filter.value)
          ) {
            filters.push({
              field: filter.field as ResearchFilterField,
              operator: filter.operator,
              value: filter.value,
            });
          }
        });
      }
      if (
        typeof id === "string" &&
        QUERY_ID.test(id) &&
        typeof raw.name === "string" &&
        raw.name.trim() === raw.name &&
        raw.name.trim() !== "" &&
        raw.name.length <= RESEARCH_QUERY_LIMITS.maxNameLength &&
        !hasControlCharacters(raw.name) &&
        viewId !== null &&
        Array.isArray(raw.filters) &&
        raw.filters.length === filters.length &&
        raw.filters.length <= RESEARCH_QUERY_LIMITS.maxFiltersPerQuery
      ) {
        queries.push({ id: id.toLowerCase(), name: raw.name, viewId, filters });
      }
    });
  }

  const ids = new Set<string>();
  for (const query of queries) {
    if (ids.has(query.id)) reject("$.queries", "duplicate-id");
    ids.add(query.id);
  }
  if (selectedQueryId !== null && !ids.has(selectedQueryId)) {
    reject("$.selectedQueryId", "invalid-reference");
  }

  const compareQueryIds: string[] = [];
  if (
    Array.isArray(input.compareQueryIds) &&
    input.compareQueryIds.length <= RESEARCH_QUERY_LIMITS.maxCompareQueries
  ) {
    for (const [index, rawId] of input.compareQueryIds.entries()) {
      if (typeof rawId !== "string" || !QUERY_ID.test(rawId)) {
        reject(`$.compareQueryIds[${index}]`, "invalid-value");
        continue;
      }
      const query = queries.find((candidate) => candidate.id === rawId.toLowerCase());
      if (!query) reject(`$.compareQueryIds[${index}]`, "invalid-reference");
      else compareQueryIds.push(query.id);
    }
  }
  if (new Set(compareQueryIds).size !== compareQueryIds.length)
    reject("$.compareQueryIds", "invalid-value");
  const comparisonViews = compareQueryIds.map(
    (id) => queries.find((query) => query.id === id)?.viewId,
  );
  if (
    comparisonViews.length > 1 &&
    comparisonViews.some((viewId) => viewId !== comparisonViews[0])
  ) {
    reject("$.compareQueryIds", "invalid-reference");
  }
  if (selectedQueryId !== null) {
    const selectedView = queries.find((query) => query.id === selectedQueryId)?.viewId;
    if (
      selectedView &&
      compareQueryIds.some(
        (id) => queries.find((query) => query.id === id)?.viewId !== selectedView,
      )
    ) {
      reject("$.compareQueryIds", "invalid-reference");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const config: ResearchQueryConfigV1 = {
    schemaVersion: RESEARCH_QUERY_CONFIG_VERSION,
    queries,
    selectedQueryId,
    compareQueryIds,
  };
  if (
    new TextEncoder().encode(JSON.stringify(config)).byteLength >
    RESEARCH_QUERY_LIMITS.maxSerializedBytes
  ) {
    return { ok: false, errors: [{ path: "$", code: "too-large" }] };
  }
  return { ok: true, value: config };
}

export function emptyResearchQueryConfig(): ResearchQueryConfigV1 {
  return {
    schemaVersion: RESEARCH_QUERY_CONFIG_VERSION,
    queries: [],
    selectedQueryId: null,
    compareQueryIds: [],
  };
}

/** Adds/replaces one saved query while enforcing the same bounds used by storage parsing. */
export function saveResearchQuery(
  current: unknown,
  query: SavedResearchQueryV1,
): ResearchQueryConfigResult {
  const parsed = parseResearchQueryConfig(current);
  if (!parsed.ok) return parsed;
  const withoutExisting = parsed.value.queries.filter((item) => item.id !== query.id);
  const nextQueries = [...withoutExisting, query];
  if (nextQueries.length > RESEARCH_QUERY_LIMITS.maxSavedQueries) {
    return { ok: false, errors: [{ path: "$.queries", code: "too-large" }] };
  }
  return parseResearchQueryConfig({
    ...parsed.value,
    queries: nextQueries,
    selectedQueryId: query.id,
  });
}

export function filterResearchRows<Row extends object>(
  rows: readonly Row[],
  filters: readonly ResearchFilterV1[],
): readonly Row[] {
  return rows.filter((row) =>
    filters.every((filter) => {
      const raw = Reflect.get(row, filter.field) as unknown;
      if (typeof raw !== "string") return false;
      const actual = raw.toLocaleLowerCase("en-US");
      const expected = filter.value.toLocaleLowerCase("en-US");
      return filter.operator === "equals" ? actual === expected : actual.includes(expected);
    }),
  );
}
