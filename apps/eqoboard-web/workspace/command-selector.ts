export type WorkspaceSelectionIdentity = Readonly<{
  workspaceId: string | null;
  tabId: string | null;
}>;

export function canRegisterActiveWorkspaceSymbolSelector(
  input: Readonly<{
    authReady: boolean;
    hasWorkspaceWritePermission: boolean;
    canEdit: boolean;
    loadStatus: "loading" | "ready" | "error";
    workspaceId: string | null;
    tabId: string | null;
  }>,
): boolean {
  return (
    input.authReady &&
    input.hasWorkspaceWritePermission &&
    input.canEdit &&
    input.loadStatus === "ready" &&
    input.workspaceId !== null &&
    input.tabId !== null
  );
}

/** Binds the shell command callback to the workspace and tab that registered it. */
export function bindActiveWorkspaceSymbolSelector(
  identity: Readonly<{ workspaceId: string; tabId: string }>,
  getCurrentIdentity: () => WorkspaceSelectionIdentity,
  selectSymbol: (symbol: string) => void,
): (symbol: string) => void {
  return (symbol) => {
    const current = getCurrentIdentity();
    if (current.workspaceId !== identity.workspaceId || current.tabId !== identity.tabId) return;
    selectSymbol(symbol);
  };
}
