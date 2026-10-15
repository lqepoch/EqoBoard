import type { WidgetInstanceV1 } from "../widgets/sdk/contracts";

/** Versioned, user-owned workspace document. This module contains no UI or wire DTOs. */
export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_EXPORT_FORMAT = "eqoboard.workspace-export" as const;

export const WORKSPACE_LIMITS = Object.freeze({
  maxWorkspaces: 12,
  maxTabsPerWorkspace: 12,
  maxWidgetsPerTab: 24,
  maxWatchlistSymbols: 100,
  maxUserTemplates: 24,
  maxDocumentBytes: 64 * 1024,
  maxNameLength: 48,
  maxSymbolLength: 24,
  maxWidgetConfigBytes: 8 * 1024,
  gridColumns: 12,
  gridMaxRows: 500,
});

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Persisted identity is the type-only SDK contract; renderer IDs never enter storage. */
export type WorkspaceWidgetInstanceV1 = WidgetInstanceV1;

export type GridPlacementV1 = Readonly<{
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}>;

export type WorkspaceTabV1 = Readonly<{
  id: string;
  name: string;
  widgets: readonly WorkspaceWidgetInstanceV1[];
  placements: readonly GridPlacementV1[];
  maximizedInstanceId: string | null;
}>;

export type WorkspaceMarketContextV1 = Readonly<{
  activeSymbol: string;
  watchlist: readonly string[];
}>;

export type WorkspaceV1 = Readonly<{
  id: string;
  name: string;
  activeTabId: string;
  marketContext: WorkspaceMarketContextV1;
  tabs: readonly WorkspaceTabV1[];
}>;

export type WorkspaceTemplateV1 = Readonly<{
  id: string;
  name: string;
  marketContext: WorkspaceMarketContextV1;
  tab: WorkspaceTabV1;
}>;

export type WorkspaceDocumentV1 = Readonly<{
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  activeWorkspaceId: string;
  workspaces: readonly WorkspaceV1[];
  userTemplates: readonly WorkspaceTemplateV1[];
}>;

export type WorkspaceExportV1 = Readonly<{
  format: typeof WORKSPACE_EXPORT_FORMAT;
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  document: WorkspaceDocumentV1;
}>;

export type WorkspaceRevision = string;

export type WorkspaceRepositorySnapshot = Readonly<{
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  revision: WorkspaceRevision;
  document: WorkspaceDocumentV1 | null;
}>;

export type WorkspaceSaveRequestV1 = Readonly<{
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  document: WorkspaceDocumentV1;
}>;

export function createId(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("A secure UUID generator is unavailable in this browser.");
  }
  return crypto.randomUUID();
}

export function createEmptyWorkspaceDocument(): WorkspaceDocumentV1 {
  const workspaceId = createId();
  const tabId = createId();
  const tab: WorkspaceTabV1 = {
    id: tabId,
    name: "Overview",
    widgets: [],
    placements: [],
    maximizedInstanceId: null,
  };
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkspaceId: workspaceId,
    workspaces: [{
      id: workspaceId,
      name: "Workspace 1",
      activeTabId: tabId,
      marketContext: { activeSymbol: "SPY", watchlist: ["SPY", "QQQ", "AAPL"] },
      tabs: [tab],
    }],
    userTemplates: [],
  };
}
