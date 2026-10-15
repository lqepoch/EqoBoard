import { describe, expect, it } from "vitest";
import {
  createWorkspaceExport,
  parseWorkspaceDocument,
  parseWorkspaceExport,
  parseWorkspaceJson,
} from "../../workspace/schema";
import type { WorkspaceDocumentV1 } from "../../workspace/model";

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  tab: "22222222-2222-4222-8222-222222222222",
  widget: "33333333-3333-4333-8333-333333333333",
};

function validDocument(): WorkspaceDocumentV1 {
  return {
    schemaVersion: 1,
    activeWorkspaceId: ids.workspace,
    workspaces: [{
      id: ids.workspace,
      name: "Review",
      activeTabId: ids.tab,
      marketContext: { activeSymbol: "SPY", watchlist: ["SPY", "QQQ"] },
      tabs: [{
        id: ids.tab,
        name: "Overview",
        widgets: [{
          instanceId: ids.widget,
          manifestId: "native.quote",
          manifestVersion: "1.0.0",
          configSchemaId: "native.quote.v1",
          config: {},
          symbolBinding: { mode: "active" },
        }],
        placements: [{ i: ids.widget, x: 0, y: 0, w: 4, h: 4 }],
        maximizedInstanceId: null,
      }],
    }],
    userTemplates: [],
  };
}

describe("workspace migration v1 contract", () => {
  it("round-trips only the bounded workspace document and exact export envelope", () => {
    const source = validDocument();
    const parsed = parseWorkspaceDocument(source);
    expect(parsed).toEqual({ ok: true, value: source });

    const exported = createWorkspaceExport(source);
    expect(Object.keys(exported).sort()).toEqual(["document", "format", "schemaVersion"]);
    expect(parseWorkspaceExport(exported)).toEqual({ ok: true, value: exported });
    expect(JSON.stringify(exported)).not.toMatch(/access.?token|authorization|account|order/i);
  });

  it("rejects ownership, authentication, and execution data at the document boundary", () => {
    for (const field of ["auth", "storagePartition", "accessToken", "account", "orders"]) {
      const candidate = { ...validDocument(), [field]: { sentinel: "must-not-be-exported" } };
      const parsed = parseWorkspaceDocument(candidate);
      expect(parsed.ok, `unexpectedly accepted root field ${field}`).toBe(false);
      if (!parsed.ok) expect(parsed.errors.some((error) => error.code === "unknown-field")).toBe(true);
    }

    const exportWithIdentity = {
      ...createWorkspaceExport(validDocument()),
      owner: "issuer|subject",
    };
    expect(parseWorkspaceExport(exportWithIdentity).ok).toBe(false);
  });

  it("rejects workspace IDs or placements that do not resolve exactly", () => {
    const base = validDocument();
    const withOrphanPlacement: unknown = {
      ...base,
      workspaces: base.workspaces.map((workspace) => ({
        ...workspace,
        tabs: workspace.tabs.map((tab) => ({
          ...tab,
          placements: [...tab.placements, {
            i: "44444444-4444-4444-8444-444444444444",
            x: 5,
            y: 0,
            w: 2,
            h: 2,
          }],
        })),
      })),
    };
    const orphanResult = parseWorkspaceDocument(withOrphanPlacement);
    expect(orphanResult.ok).toBe(false);
    if (!orphanResult.ok) expect(orphanResult.errors.some((error) => error.code === "missing-reference")).toBe(true);

    const outOfBounds: unknown = {
      ...base,
      workspaces: base.workspaces.map((workspace) => ({
        ...workspace,
        tabs: workspace.tabs.map((tab) => ({
          ...tab,
          placements: tab.placements.map((placement) => ({ ...placement, x: 10 })),
        })),
      })),
    };
    const boundsResult = parseWorkspaceDocument(outOfBounds);
    expect(boundsResult.ok).toBe(false);
    if (!boundsResult.ok) expect(boundsResult.errors.some((error) => error.code === "grid-out-of-bounds")).toBe(true);
  });

  it("rejects overlapping placements, unknown fields, and malformed JSON instead of repairing silently", () => {
    const base = validDocument();
    const overlapping: unknown = {
      ...base,
      workspaces: base.workspaces.map((workspace) => ({
        ...workspace,
        tabs: workspace.tabs.map((tab) => ({
          ...tab,
          widgets: [...tab.widgets, {
            instanceId: "44444444-4444-4444-8444-444444444444",
            manifestId: "native.chart",
            manifestVersion: "1.0.0",
            configSchemaId: "native.chart.v1",
            config: {},
          }],
          placements: [...tab.placements, {
            i: "44444444-4444-4444-8444-444444444444",
            x: 2,
            y: 1,
            w: 4,
            h: 4,
          }],
        })),
      })),
    };
    const overlapResult = parseWorkspaceDocument(overlapping);
    expect(overlapResult.ok).toBe(false);
    if (!overlapResult.ok) expect(overlapResult.errors.some((error) => error.code === "grid-overlap")).toBe(true);

    expect(parseWorkspaceDocument({ ...validDocument(), revision: "stale" }).ok).toBe(false);
    const malformed = parseWorkspaceJson("{ definitely not json");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.errors[0].code).toBe("invalid-json");
  });

  it("enforces the explicit watchlist and serialized document limits", () => {
    const base = validDocument();
    const tooManySymbols: unknown = {
      ...base,
      workspaces: base.workspaces.map((workspace) => ({
        ...workspace,
        marketContext: {
          ...workspace.marketContext,
          watchlist: Array.from({ length: 101 }, (_, index) => `S${index}`),
        },
      })),
    };
    const symbolResult = parseWorkspaceDocument(tooManySymbols);
    expect(symbolResult.ok).toBe(false);
    if (!symbolResult.ok) expect(symbolResult.errors.some((error) => error.code === "too-many-items")).toBe(true);

    const oversized = JSON.stringify({ ...validDocument(), padding: "x".repeat(64 * 1024) });
    const oversizedResult = parseWorkspaceJson(oversized);
    expect(oversizedResult.ok).toBe(false);
    if (!oversizedResult.ok) expect(oversizedResult.errors[0].code).toBe("too-large");
  });
});
