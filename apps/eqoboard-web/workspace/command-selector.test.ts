import { describe, expect, it, vi } from "vitest";
import {
  bindActiveWorkspaceSymbolSelector,
  canRegisterActiveWorkspaceSymbolSelector,
} from "./command-selector";

describe("active workspace symbol command binding", () => {
  it("registers only for a ready authenticated writable workspace and active tab", () => {
    const eligible = {
      authReady: true,
      hasWorkspaceWritePermission: true,
      canEdit: true,
      loadStatus: "ready" as const,
      workspaceId: "workspace-a",
      tabId: "tab-a",
    };
    expect(canRegisterActiveWorkspaceSymbolSelector(eligible)).toBe(true);
    expect(canRegisterActiveWorkspaceSymbolSelector({ ...eligible, canEdit: false })).toBe(false);
    expect(canRegisterActiveWorkspaceSymbolSelector({ ...eligible, authReady: false })).toBe(false);
    expect(
      canRegisterActiveWorkspaceSymbolSelector({ ...eligible, hasWorkspaceWritePermission: false }),
    ).toBe(false);
    expect(canRegisterActiveWorkspaceSymbolSelector({ ...eligible, loadStatus: "loading" })).toBe(
      false,
    );
    expect(canRegisterActiveWorkspaceSymbolSelector({ ...eligible, loadStatus: "error" })).toBe(
      false,
    );
    expect(canRegisterActiveWorkspaceSymbolSelector({ ...eligible, workspaceId: null })).toBe(
      false,
    );
    expect(canRegisterActiveWorkspaceSymbolSelector({ ...eligible, tabId: null })).toBe(false);
  });

  it("selects only while the registering workspace and tab remain active", () => {
    const current = { workspaceId: "workspace-a", tabId: "tab-a" };
    const selectSymbol = vi.fn();
    const select = bindActiveWorkspaceSymbolSelector(
      { workspaceId: "workspace-a", tabId: "tab-a" },
      () => current,
      selectSymbol,
    );

    select("NVDA");
    expect(selectSymbol).toHaveBeenCalledTimes(1);
    expect(selectSymbol).toHaveBeenCalledWith("NVDA");

    current.tabId = "tab-b";
    select("AAPL");
    current.tabId = "tab-a";
    current.workspaceId = "workspace-b";
    select("MSFT");
    expect(selectSymbol).toHaveBeenCalledTimes(1);
  });
});
