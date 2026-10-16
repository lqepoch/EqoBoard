import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneDocumentWorkspaces,
  cloneTab,
  cloneWorkspace,
  createWorkspaceFromTemplate,
} from "../../workspace/transforms";
import type { WorkspaceDocumentV1 } from "../../workspace/model";

function workspaceDocument(): WorkspaceDocumentV1 {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const tabId = "22222222-2222-4222-8222-222222222222";
  const widgetId = "33333333-3333-4333-8333-333333333333";
  return {
    schemaVersion: 1,
    activeWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name: "Review",
        activeTabId: tabId,
        marketContext: { activeSymbol: "SPY", watchlist: ["SPY", "QQQ"] },
        tabs: [
          {
            id: tabId,
            name: "Overview",
            widgets: [
              {
                instanceId: widgetId,
                manifestId: "native.quote",
                manifestVersion: "1.0.0",
                configSchemaId: "native.quote.v1",
                config: { display: "compact" },
              },
            ],
            placements: [{ i: widgetId, x: 0, y: 0, w: 4, h: 3 }],
            maximizedInstanceId: widgetId,
          },
        ],
      },
    ],
    userTemplates: [],
  };
}

describe("workspace copy/migration identity rules", () => {
  let nextId = 1;

  beforeEach(() => {
    nextId = 1;
    vi.stubGlobal("crypto", {
      randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("assigns fresh tab and widget IDs while keeping placements referentially valid", () => {
    const source = workspaceDocument().workspaces[0].tabs[0];
    const copy = cloneTab(source, "Copied tab");

    expect(copy.id).not.toBe(source.id);
    expect(copy.widgets[0].instanceId).not.toBe(source.widgets[0].instanceId);
    expect(copy.placements).toEqual([expect.objectContaining({ i: copy.widgets[0].instanceId })]);
    expect(copy.maximizedInstanceId).toBeNull();
    expect(copy.widgets[0].config).toEqual(source.widgets[0].config);
  });

  it("assigns new workspace, tab, and widget identities without changing market intent", () => {
    const source = workspaceDocument().workspaces[0];
    const copy = cloneWorkspace(source, "Imported copy");

    expect(copy.id).not.toBe(source.id);
    expect(copy.activeTabId).not.toBe(source.activeTabId);
    expect(copy.activeTabId).toBe(copy.tabs[0].id);
    expect(copy.tabs[0].widgets[0].instanceId).not.toBe(source.tabs[0].widgets[0].instanceId);
    expect(copy.tabs[0].placements[0].i).toBe(copy.tabs[0].widgets[0].instanceId);
    expect(copy.marketContext).toEqual(source.marketContext);
  });

  it("preserves the selected workspace when cloning an imported document", () => {
    const first = workspaceDocument();
    const firstWorkspace = first.workspaces[0];
    const secondWorkspaceId = "44444444-4444-4444-8444-444444444444";
    const secondTabId = "55555555-5555-4555-8555-555555555555";
    const secondWorkspace = {
      ...firstWorkspace,
      id: secondWorkspaceId,
      name: "Second workspace",
      activeTabId: secondTabId,
      tabs: [
        {
          id: secondTabId,
          name: "Research",
          widgets: [],
          placements: [],
          maximizedInstanceId: null,
        },
      ],
    };
    const imported = {
      ...first,
      activeWorkspaceId: secondWorkspaceId,
      workspaces: [firstWorkspace, secondWorkspace],
    };

    const copy = cloneDocumentWorkspaces(imported);

    expect(copy.workspaces).toHaveLength(2);
    expect(copy.activeWorkspaceId).toBe(copy.workspaces[1].id);
    expect(copy.activeWorkspaceId).not.toBe(secondWorkspaceId);
  });

  it("creates a workspace from a template with fresh nested identities", () => {
    const source = workspaceDocument().workspaces[0];
    const template = { marketContext: source.marketContext, tab: source.tabs[0] };
    const created = createWorkspaceFromTemplate(template, "Template copy");

    expect(created.id).not.toBe(source.id);
    expect(created.tabs[0].id).not.toBe(template.tab.id);
    expect(created.tabs[0].widgets[0].instanceId).not.toBe(template.tab.widgets[0].instanceId);
    expect(created.tabs[0].placements[0].i).toBe(created.tabs[0].widgets[0].instanceId);
  });
});
