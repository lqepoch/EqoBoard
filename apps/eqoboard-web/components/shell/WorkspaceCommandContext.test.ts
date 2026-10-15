import { describe, expect, it, vi } from "vitest";
import { createWorkspaceCommandRegistry } from "./WorkspaceCommandContext";

describe("workspace command registration", () => {
  it("replaces the active selector and prevents a stale disposer clearing the replacement", () => {
    const registry = createWorkspaceCommandRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = registry.registerActiveSymbolSelector(first);
    const disposeSecond = registry.registerActiveSymbolSelector(second);

    disposeFirst();
    expect(registry.selectSymbol("NVDA")).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("NVDA");

    disposeSecond();
    expect(registry.selectSymbol("AAPL")).toBe(false);
  });

  it("does not invoke a selector after its workspace owner disposes it", () => {
    const registry = createWorkspaceCommandRegistry();
    const select = vi.fn();
    const dispose = registry.registerActiveSymbolSelector(select);

    dispose();
    expect(registry.selectSymbol("AAPL")).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});
