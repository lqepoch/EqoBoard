"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import {
  parseResearchEnvelope,
  projectResearchTable,
  researchTableRowsWithKeys,
  readResearchRequest,
  type ResearchReadRequest,
  type ResearchTableProjection,
  type ResearchEnvelopeByOperation,
  type ResearchDataOperationMap,
} from "@/features/research/data";
import {
  filterResearchRows,
  parseResearchQueryConfig,
  RESEARCH_FILTER_FIELDS,
  RESEARCH_VIEW_IDS,
  type ResearchFilterField,
  type ResearchFilterOperator,
  type ResearchFilterV1,
  type ResearchQueryConfigV1,
  type ResearchViewId,
  type SavedResearchQueryV1,
} from "@/features/research/query-config";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import { hasControlCharacters } from "@/features/research/text";
import styles from "./research-widgets.module.css";

export type SavedQueriesConfigV1 = ResearchQueryConfigV1;

const VIEW_LABELS: Readonly<Record<ResearchViewId, string>> = Object.freeze({
  news: "News",
  "macro-us": "Macro · U.S.",
  "macro-eu": "Macro · Europe",
  "economic-calendar": "Economic calendar",
  "earnings-calendar": "Earnings calendar",
  "earnings-history": "Earnings history",
  insider: "SEC insider filings",
  "screener-us": "U.S. screener",
  "screener-eu": "Europe screener",
  "heatmap-us": "U.S. heatmap",
  "heatmap-eu": "Europe heatmap",
  crypto: "Crypto markets",
  "crypto-global": "Crypto global",
});

function selectedFilter(query: SavedResearchQueryV1, field: string): ResearchFilterV1 | undefined {
  return query.filters.find((filter) => filter.field === field);
}

function querySymbol(query: SavedResearchQueryV1): string | undefined {
  const filter = selectedFilter(query, "symbol");
  return filter?.operator === "equals" ? filter.value.toUpperCase() : undefined;
}

export function buildSavedQueryRequest(query: SavedResearchQueryV1): ResearchReadRequest | null {
  switch (query.viewId) {
    case "news": {
      const symbol = querySymbol(query);
      return { operation: "research.news", input: symbol ? { symbol } : {} };
    }
    case "macro-us":
      return { operation: "research.macro", input: { region: "us" } };
    case "macro-eu":
      return { operation: "research.macro", input: { region: "eu" } };
    case "economic-calendar":
      return { operation: "research.economicCalendar", input: {} };
    case "earnings-calendar": {
      const symbol = querySymbol(query);
      return symbol
        ? { operation: "research.earningsCalendar", input: { symbols: [symbol] } }
        : null;
    }
    case "earnings-history": {
      const symbol = querySymbol(query);
      return symbol ? { operation: "research.earningsHistory", input: { symbol } } : null;
    }
    case "insider": {
      const symbol = querySymbol(query);
      return symbol ? { operation: "research.insider", input: { symbol } } : null;
    }
    case "screener-us":
      return { operation: "research.screener", input: { market: "us", limit: 500 } };
    case "screener-eu":
      return { operation: "research.screener", input: { market: "eu", limit: 500 } };
    case "heatmap-us":
      return { operation: "research.heatmap", input: { market: "us" } };
    case "heatmap-eu":
      return { operation: "research.heatmap", input: { market: "eu" } };
    case "crypto":
      return { operation: "research.crypto", input: {} };
    case "crypto-global":
      return { operation: "research.cryptoGlobal", input: {} };
  }
}

type LoadedComparison = Readonly<{
  query: SavedResearchQueryV1;
  table: ResearchTableProjection | null;
  envelope: ResearchEnvelopeByOperation[keyof ResearchEnvelopeByOperation] | null;
  message: string | null;
}>;

type ComparisonState = Readonly<
  { status: "idle" | "loading" } | { status: "ready"; values: readonly LoadedComparison[] }
>;

function applyQueryFilters(
  query: SavedResearchQueryV1,
  table: ResearchTableProjection,
): ResearchTableProjection {
  const filtered = filterResearchRows(table.rows, query.filters);
  return Object.freeze({ ...table, rows: Object.freeze([...filtered]) });
}

function useQueryComparisons(
  host: WidgetProps<SavedQueriesConfigV1, ResearchDataOperationMap, WidgetNoActionMap>["host"],
  config: SavedQueriesConfigV1,
  allowed: boolean,
): Readonly<{ state: ComparisonState; refresh: () => void }> {
  const planKey = JSON.stringify({
    queries: config.queries,
    selectedQueryId: config.selectedQueryId,
    compareQueryIds: config.compareQueryIds,
  });
  const plan = useMemo(() => {
    const snapshot = JSON.parse(planKey) as Pick<
      SavedQueriesConfigV1,
      "queries" | "selectedQueryId" | "compareQueryIds"
    >;
    const queryById = new Map(snapshot.queries.map((query) => [query.id, query]));
    const selected =
      snapshot.queries.find((query) => query.id === snapshot.selectedQueryId) ?? null;
    const comparisons = snapshot.compareQueryIds
      .map((id) => queryById.get(id))
      .filter((query): query is SavedResearchQueryV1 => Boolean(query));
    return selected
      ? [selected, ...comparisons.filter((query) => query.id !== selected.id)]
      : comparisons;
  }, [planKey]);
  const [state, setState] = useState<ComparisonState>({ status: "idle" });
  const activeController = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    activeController.current?.abort();
    if (!allowed || plan.length === 0) {
      setState({ status: "idle" });
      return;
    }
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    activeController.current = controller;
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    setState({ status: "loading" });
    void (async () => {
      const values: LoadedComparison[] = [];
      for (const query of plan) {
        if (controller.signal.aborted) return;
        const request = buildSavedQueryRequest(query);
        if (!request) {
          values.push({
            query,
            table: null,
            envelope: null,
            message: "This view needs an explicit symbol filter before it can request data.",
          });
          continue;
        }
        try {
          const response = await readResearchRequest(host.data, request, controller.signal);
          const envelope = parseResearchEnvelope(request.operation, response);
          if (!envelope) {
            values.push({
              query,
              table: null,
              envelope: null,
              message: "The response did not pass its research envelope validation.",
            });
            continue;
          }
          const table = projectResearchTable(request.operation, envelope);
          values.push({ query, table: applyQueryFilters(query, table), envelope, message: null });
        } catch {
          if (controller.signal.aborted) return;
          values.push({
            query,
            table: null,
            envelope: null,
            message: "Research data is unavailable for this saved query.",
          });
        }
      }
      if (!controller.signal.aborted) setState({ status: "ready", values });
    })().finally(() => {
      lifecycle.signal.removeEventListener("abort", abort);
      if (activeController.current === controller) activeController.current = null;
    });
  }, [allowed, host.data, host.lifecycle, plan]);

  useEffect(() => {
    refresh();
    return () => activeController.current?.abort();
  }, [refresh]);

  return { state, refresh };
}

function safeText(value: unknown): string {
  return value === null || value === undefined
    ? "—"
    : typeof value === "string" || typeof value === "number"
      ? String(value)
      : "—";
}

function changeConfig(
  onConfigChange: WidgetProps<
    SavedQueriesConfigV1,
    ResearchDataOperationMap,
    WidgetNoActionMap
  >["onConfigChange"],
  next: SavedQueriesConfigV1,
): void {
  onConfigChange(next);
}

export function SavedQueriesWidget(
  props: WidgetProps<SavedQueriesConfigV1, ResearchDataOperationMap, WidgetNoActionMap>,
) {
  const { config, onConfigChange, host } = props;
  const [name, setName] = useState("");
  const [viewId, setViewId] = useState<ResearchViewId>("news");
  const [field, setField] = useState<ResearchFilterField>("title");
  const [operator, setOperator] = useState<ResearchFilterOperator>("contains");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState("");
  const hasReadPermission =
    host.auth.authenticated && host.auth.permissions.includes("research:read");
  const { state: comparisons, refresh } = useQueryComparisons(host, config, hasReadPermission);
  const selectedQuery = config.queries.find((query) => query.id === config.selectedQueryId) ?? null;
  const allowedFields = RESEARCH_FILTER_FIELDS[viewId] as readonly ResearchFilterField[];

  function update(next: SavedQueriesConfigV1): void {
    changeConfig(onConfigChange, next);
  }

  function selectView(nextView: ResearchViewId): void {
    const nextFields = RESEARCH_FILTER_FIELDS[nextView] as readonly ResearchFilterField[];
    setViewId(nextView);
    setField(nextFields[0] ?? "symbol");
  }

  function saveQuery(): void {
    const normalizedName = name.trim();
    if (
      !normalizedName ||
      normalizedName.length > 48 ||
      !value.trim() ||
      value.length > 96 ||
      hasControlCharacters(value)
    ) {
      setFormError("Enter a name and one bounded filter value.");
      return;
    }
    const query: SavedResearchQueryV1 = {
      id: crypto.randomUUID(),
      name: normalizedName,
      viewId,
      filters: [{ field, operator, value: value.trim() }],
    };
    const parsed = parseResearchQueryConfig({
      ...config,
      queries: [...config.queries, query],
      selectedQueryId: query.id,
      compareQueryIds: [],
    });
    if (!parsed.ok) {
      setFormError(
        parsed.errors[0]?.code === "too-large"
          ? "The workspace query limit has been reached."
          : "This query did not pass its bounded schema.",
      );
      return;
    }
    setFormError("");
    update(parsed.value);
    setName("");
  }

  function toggleCompare(query: SavedResearchQueryV1): void {
    const selected = config.queries.find((candidate) => candidate.id === config.selectedQueryId);
    if (selected && selected.viewId !== query.viewId) {
      setFormError("Saved queries can be compared only within the same view.");
      return;
    }
    const existingCompareView = config.queries.find(
      (candidate) => candidate.id === config.compareQueryIds[0],
    )?.viewId;
    if (existingCompareView && existingCompareView !== query.viewId) {
      setFormError("Saved queries can be compared only within the same view.");
      return;
    }
    const compare = config.compareQueryIds.includes(query.id)
      ? config.compareQueryIds.filter((id) => id !== query.id)
      : [...config.compareQueryIds, query.id];
    if (compare.length > 2) {
      setFormError("Choose at most two comparison queries.");
      return;
    }
    setFormError("");
    update({ ...config, compareQueryIds: compare });
  }

  function removeQuery(queryId: string): void {
    update({
      ...config,
      queries: config.queries.filter((query) => query.id !== queryId),
      selectedQueryId: config.selectedQueryId === queryId ? null : config.selectedQueryId,
      compareQueryIds: config.compareQueryIds.filter((id) => id !== queryId),
    });
  }

  return (
    <section className={styles.widget} aria-label="Saved research queries">
      <header className={styles.header}>
        <div>
          <h2>Saved research queries</h2>
          <p>
            Only named views and bounded text filters are stored in this widget’s workspace config.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={!hasReadPermission || comparisons.status === "loading"}
        >
          Refresh comparison
        </button>
      </header>
      {!hasReadPermission ? (
        <p className={styles.empty}>
          Sign in with the research:read permission to compare live observations.
        </p>
      ) : null}
      <div className={styles.form}>
        <label className={styles.control}>
          <span>Query name</span>
          <input
            value={name}
            maxLength={48}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className={styles.control}>
          <span>View</span>
          <select
            value={viewId}
            onChange={(event) => selectView(event.currentTarget.value as ResearchViewId)}
          >
            {RESEARCH_VIEW_IDS.map((view) => (
              <option value={view} key={view}>
                {VIEW_LABELS[view]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span>Filter field</span>
          <select
            value={field}
            onChange={(event) => setField(event.currentTarget.value as ResearchFilterField)}
          >
            {allowedFields.map((key) => (
              <option value={key} key={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span>Match</span>
          <select
            value={operator}
            onChange={(event) => setOperator(event.currentTarget.value as ResearchFilterOperator)}
          >
            <option value="contains">contains</option>
            <option value="equals">equals</option>
          </select>
        </label>
        <label className={styles.control}>
          <span>Value</span>
          <input
            value={value}
            maxLength={96}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </label>
        <button type="button" onClick={saveQuery} disabled={config.queries.length >= 12}>
          Save query
        </button>
      </div>
      {formError ? (
        <p className={styles.error} role="alert">
          {formError}
        </p>
      ) : null}
      <div className={styles.savedQueries}>
        <section className={styles.queryList} aria-label="Saved queries">
          {config.queries.length === 0 ? (
            <p className={styles.empty}>No saved queries yet.</p>
          ) : null}
          {config.queries.map((query) => (
            <article className={styles.savedQuery} key={query.id}>
              <span>
                <button
                  type="button"
                  onClick={() =>
                    update({
                      ...config,
                      selectedQueryId: query.id,
                      compareQueryIds: config.compareQueryIds.filter(
                        (id) =>
                          config.queries.find((candidate) => candidate.id === id)?.viewId ===
                          query.viewId,
                      ),
                    })
                  }
                  aria-pressed={selectedQuery?.id === query.id}
                >
                  {query.name} · {VIEW_LABELS[query.viewId]}
                </button>
              </span>
              <button
                type="button"
                onClick={() => toggleCompare(query)}
                aria-pressed={config.compareQueryIds.includes(query.id)}
              >
                {config.compareQueryIds.includes(query.id) ? "Comparing" : "Compare"}
              </button>
              <button
                type="button"
                onClick={() => removeQuery(query.id)}
                aria-label={`Remove ${query.name}`}
              >
                ×
              </button>
            </article>
          ))}
        </section>
        <div>
          {comparisons.status === "loading" ? (
            <p className={styles.empty} role="status">
              Loading comparison observations…
            </p>
          ) : null}
          {comparisons.status === "ready" && comparisons.values.length === 0 ? (
            <p className={styles.empty}>
              Select a saved query to inspect its current observations.
            </p>
          ) : null}
          {comparisons.status === "ready"
            ? comparisons.values.map((result) => (
                <article className={styles.compareResult} key={result.query.id}>
                  <h3>{result.query.name}</h3>
                  <p>
                    {VIEW_LABELS[result.query.viewId]} ·{" "}
                    {result.query.filters
                      .map((filter) => `${filter.field} ${filter.operator} “${filter.value}”`)
                      .join(" · ")}
                  </p>
                  {result.message ? <p className={styles.error}>{result.message}</p> : null}
                  {result.envelope ? (
                    <p className={styles.notice}>
                      {result.envelope.source.provider} · as of {result.envelope.asOf ?? "unknown"}{" "}
                      · {result.envelope.status} · {result.table?.rows.length ?? 0} matching rows
                    </p>
                  ) : null}
                  {result.envelope && result.table ? (
                    <QueryResultTable table={result.table} />
                  ) : null}
                </article>
              ))
            : null}
        </div>
      </div>
    </section>
  );
}

function QueryResultTable({ table }: { table: ResearchTableProjection }) {
  if (table.rows.length === 0)
    return <p className={styles.empty}>No rows match this saved filter.</p>;
  const visible = table.rows.slice(0, 5);
  const visibleRows = researchTableRowsWithKeys(visible);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {table.columns.slice(0, 6).map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map(({ row, key }) => (
            <tr key={key}>
              {table.columns.slice(0, 6).map((column) => (
                <td key={column.key}>{safeText(row[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > visible.length ? (
        <p className={styles.notice}>Showing 5 of {table.rows.length} matching rows.</p>
      ) : null}
    </div>
  );
}
