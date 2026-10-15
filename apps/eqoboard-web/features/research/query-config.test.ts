import { describe, expect, it } from "vitest";

import {
  emptyResearchQueryConfig,
  filterResearchRows,
  parseResearchQueryConfig,
  saveResearchQuery,
  type SavedResearchQueryV1,
} from "./query-config";

const queryA: SavedResearchQueryV1 = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "U.S. ten year yield",
  viewId: "macro-us",
  filters: [{ field: "id", operator: "equals", value: "DGS10" }],
};

const queryB: SavedResearchQueryV1 = {
  id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  name: "Europe inflation",
  viewId: "macro-eu",
  filters: [{ field: "id", operator: "equals", value: "HICP" }],
};

describe("native research saved queries", () => {
  it("accepts bounded static view and filter identifiers", () => {
    const result = parseResearchQueryConfig({
      schemaVersion: 1,
      queries: [queryA],
      selectedQueryId: queryA.id,
      compareQueryIds: [queryA.id],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.queries[0]?.viewId).toBe("macro-us");
      expect(result.value.selectedQueryId).toBe(queryA.id);
    }
  });

  it("rejects arbitrary operation targets and non-allowlisted fields", () => {
    const arbitraryTarget = parseResearchQueryConfig({
      schemaVersion: 1,
      queries: [{ ...queryA, viewId: "https://provider.invalid/data" }],
      selectedQueryId: null,
      compareQueryIds: [],
    });
    expect(arbitraryTarget.ok).toBe(false);

    const unknownField = parseResearchQueryConfig({
      schemaVersion: 1,
      queries: [
        {
          ...queryA,
          filters: [{ field: "range", operator: "equals", value: "1Y" }],
        },
      ],
      selectedQueryId: null,
      compareQueryIds: [],
    });
    expect(unknownField.ok).toBe(false);
  });

  it("requires comparison references to resolve to the same view", () => {
    const differentViews = parseResearchQueryConfig({
      schemaVersion: 1,
      queries: [
        queryA,
        {
          ...queryB,
          viewId: "macro",
          filters: [{ field: "series", operator: "equals", value: "DGS10" }],
        },
      ],
      selectedQueryId: queryA.id,
      compareQueryIds: [queryA.id, queryB.id],
    });
    expect(differentViews.ok).toBe(false);

    const missingQuery = parseResearchQueryConfig({
      schemaVersion: 1,
      queries: [queryA],
      selectedQueryId: queryA.id,
      compareQueryIds: [queryB.id],
    });
    expect(missingQuery.ok).toBe(false);
  });

  it("replaces a saved definition without duplicating its ID", () => {
    const initial = parseResearchQueryConfig({
      ...emptyResearchQueryConfig(),
      queries: [queryA],
      selectedQueryId: queryA.id,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const updated = saveResearchQuery(initial.value, { ...queryA, name: "Updated headlines" });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.queries).toHaveLength(1);
      expect(updated.value.queries[0]?.name).toBe("Updated headlines");
      expect(updated.value.selectedQueryId).toBe(queryA.id);
    }
  });

  it("filters text observations case insensitively without coercing non-text values", () => {
    const rows = [
      { symbol: "SPY" },
      { symbol: "QQQ" },
      { symbol: null },
      { symbol: 42 },
    ];
    const filtered = filterResearchRows(rows, [
      { field: "symbol", operator: "contains", value: "sp" },
    ]);
    expect(filtered.map((row) => row.symbol)).toEqual(["SPY"]);
  });
});
