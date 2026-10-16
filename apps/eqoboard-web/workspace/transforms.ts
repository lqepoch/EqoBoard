import {
  createId,
  type WorkspaceDocumentV1,
  type WorkspaceMarketContextV1,
  type WorkspaceTabV1,
  type WorkspaceTemplateV1,
  type WorkspaceV1,
} from "./model";

function requireRemappedInstanceId(idMap: ReadonlyMap<string, string>, sourceId: string): string {
  const remappedId = idMap.get(sourceId);
  if (remappedId === undefined) {
    throw new Error("Workspace clone invariant failed: widget identity was not mapped.");
  }
  return remappedId;
}

export function createEmptyTab(name = "Overview"): WorkspaceTabV1 {
  return { id: createId(), name, widgets: [], placements: [], maximizedInstanceId: null };
}

export function cloneTab(source: WorkspaceTabV1, name = source.name): WorkspaceTabV1 {
  const idMap = new Map(source.widgets.map((widget) => [widget.instanceId, createId()]));
  const widgets = source.widgets.map((widget) => ({
    ...widget,
    instanceId: requireRemappedInstanceId(idMap, widget.instanceId),
    config: structuredClone(widget.config),
  }));
  return {
    id: createId(),
    name,
    widgets,
    placements: source.placements.map((placement) => ({
      ...placement,
      i: requireRemappedInstanceId(idMap, placement.i),
    })),
    maximizedInstanceId: null,
  };
}

export function cloneWorkspace(source: WorkspaceV1, name = source.name): WorkspaceV1 {
  const tabs = source.tabs.map((tab) => cloneTab(tab));
  const activeTabIndex = Math.max(
    0,
    source.tabs.findIndex((tab) => tab.id === source.activeTabId),
  );
  return {
    id: createId(),
    name,
    activeTabId: tabs[Math.min(activeTabIndex, tabs.length - 1)].id,
    marketContext: {
      activeSymbol: source.marketContext.activeSymbol,
      watchlist: [...source.marketContext.watchlist],
    },
    tabs,
  };
}

export function cloneTemplate(
  template: WorkspaceTemplateV1,
  name = template.name,
): WorkspaceTemplateV1 {
  return {
    id: createId(),
    name,
    marketContext: {
      activeSymbol: template.marketContext.activeSymbol,
      watchlist: [...template.marketContext.watchlist],
    },
    tab: cloneTab(template.tab),
  };
}

export function createWorkspaceFromTemplate(
  template: Pick<WorkspaceTemplateV1, "marketContext" | "tab">,
  name: string,
): WorkspaceV1 {
  const tab = cloneTab(template.tab);
  return {
    id: createId(),
    name,
    activeTabId: tab.id,
    marketContext: {
      activeSymbol: template.marketContext.activeSymbol,
      watchlist: [...template.marketContext.watchlist],
    },
    tabs: [tab],
  };
}

export function createTemplateFromWorkspace(
  workspace: WorkspaceV1,
  name: string,
): WorkspaceTemplateV1 {
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
  if (!activeTab) {
    throw new Error("Workspace clone invariant failed: active tab was not found.");
  }
  return {
    id: createId(),
    name,
    marketContext: {
      activeSymbol: workspace.marketContext.activeSymbol,
      watchlist: [...workspace.marketContext.watchlist],
    },
    tab: cloneTab(activeTab),
  };
}

export function cloneDocumentWorkspaces(document: WorkspaceDocumentV1): WorkspaceDocumentV1 {
  const workspaceIdMap = new Map<string, string>();
  const workspaces = document.workspaces.map((workspace) => cloneWorkspace(workspace));
  document.workspaces.forEach((workspace, index) => {
    const cloned = workspaces[index];
    if (cloned) workspaceIdMap.set(workspace.id, cloned.id);
  });
  const activeWorkspaceId = workspaceIdMap.get(document.activeWorkspaceId);
  if (!activeWorkspaceId) {
    throw new Error("Workspace clone invariant failed: active workspace was not mapped.");
  }
  return {
    schemaVersion: 1,
    activeWorkspaceId,
    workspaces,
    userTemplates: document.userTemplates.map((template) => cloneTemplate(template)),
  };
}

export function replaceWorkspaceInDocument(
  document: WorkspaceDocumentV1,
  workspace: WorkspaceV1,
): WorkspaceDocumentV1 {
  return {
    ...document,
    workspaces: document.workspaces.map((candidate) =>
      candidate.id === workspace.id ? workspace : candidate,
    ),
  };
}

export function emptyWorkspaceFromContext(
  id: string,
  name: string,
  marketContext: WorkspaceMarketContextV1,
): WorkspaceV1 {
  const tab = createEmptyTab();
  return {
    id,
    name,
    activeTabId: tab.id,
    marketContext: {
      activeSymbol: marketContext.activeSymbol,
      watchlist: [...marketContext.watchlist],
    },
    tabs: [tab],
  };
}
