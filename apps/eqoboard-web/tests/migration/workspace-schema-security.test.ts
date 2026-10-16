import { describe, expect, it } from "vitest";
import { parseWorkspaceDocument } from "../../workspace/schema";

const document = {
  schemaVersion: 1,
  activeWorkspaceId: "11111111-1111-4111-8111-111111111111",
  workspaces: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Review",
      activeTabId: "22222222-2222-4222-8222-222222222222",
      marketContext: { activeSymbol: "SPY", watchlist: ["SPY"] },
      tabs: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Overview",
          widgets: [
            {
              instanceId: "33333333-3333-4333-8333-333333333333",
              manifestId: "vendor.unavailable-widget",
              manifestVersion: "1.0.0",
              configSchemaId: "vendor.unavailable-widget.config.v1",
              config: {},
            },
          ],
          placements: [{ i: "33333333-3333-4333-8333-333333333333", x: 0, y: 0, w: 4, h: 4 }],
          maximizedInstanceId: null,
        },
      ],
    },
  ],
  userTemplates: [],
} as const;

describe("workspace configuration safety limits", () => {
  it("rejects credential, identity, account, order, and market-event fields even in inert config", () => {
    for (const field of [
      "accessToken",
      "storagePartition",
      "accountId",
      "orders",
      "quotes",
      "marketEvents",
    ]) {
      const candidate = structuredClone(document) as unknown as Record<string, unknown>;
      const root = candidate.workspaces as Array<Record<string, unknown>>;
      const tabs = root[0].tabs as Array<Record<string, unknown>>;
      const widgets = tabs[0].widgets as Array<Record<string, unknown>>;
      widgets[0].config = { [field]: "must not be persisted or exported" };

      const result = parseWorkspaceDocument(candidate);
      expect(result.ok, `unexpectedly accepted config field ${field}`).toBe(false);
    }
  });

  it("rejects a widget config above 8 KiB without truncating it", () => {
    const candidate = structuredClone(document) as unknown as Record<string, unknown>;
    const root = candidate.workspaces as Array<Record<string, unknown>>;
    const tabs = root[0].tabs as Array<Record<string, unknown>>;
    const widgets = tabs[0].widgets as Array<Record<string, unknown>>;
    widgets[0].config = { padding: "x".repeat(8 * 1024) };

    const result = parseWorkspaceDocument(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.code === "too-large")).toBe(true);
  });
});
