import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUiSnapshot } from "@/lib/contracts/auth";
import {
  getSymbolSearchAvailability,
  getSymbolSearchQueryIssue,
  nextPaletteOptionIndex,
  normalizeSymbolSearchQuery,
  scheduleSymbolSearch,
  symbolSearchErrorMessage,
} from "./symbol-search";
import { WidgetDataReadError } from "@/widgets/sdk/data";

const authenticatedTerminal: AuthUiSnapshot = {
  status: "authenticated",
  authenticated: true,
  displayName: "Analyst",
  permissions: ["research:read"],
  storagePartition: "opaque-user-partition",
  runtimeMode: "terminal",
  researchOrigin: null,
};

afterEach(() => vi.useRealTimers());

describe("symbol search scope and bounds", () => {
  it("trims input but rejects empty, control-character, and overlong queries", () => {
    expect(normalizeSymbolSearchQuery("  NVDA  ")).toBe("NVDA");
    expect(normalizeSymbolSearchQuery("  ")).toBeNull();
    expect(normalizeSymbolSearchQuery(`A${"B".repeat(64)}`)).toBeNull();
    expect(normalizeSymbolSearchQuery("AA\nBB")).toBeNull();
    expect(normalizeSymbolSearchQuery(" AAPL\n ")).toBeNull();
    expect(getSymbolSearchQueryIssue(`A${"B".repeat(64)}`)).toBe("too-long");
    expect(getSymbolSearchQueryIssue("AA\nBB")).toBe("control-characters");
    expect(getSymbolSearchQueryIssue(" ")).toBeNull();
  });

  it("fails closed unless terminal research access is present", () => {
    expect(getSymbolSearchAvailability(authenticatedTerminal)).toBe("ready");
    expect(getSymbolSearchAvailability({ ...authenticatedTerminal, runtimeMode: "research" }))
      .toBe("terminal-runtime-required");
    expect(getSymbolSearchAvailability({ ...authenticatedTerminal, runtimeMode: undefined }))
      .toBe("terminal-runtime-required");
    expect(getSymbolSearchAvailability({ ...authenticatedTerminal, permissions: [] }))
      .toBe("research-permission-required");
    expect(getSymbolSearchAvailability({
      ...authenticatedTerminal,
      authenticated: false,
      status: "sign-in-required",
    })).toBe("sign-in-required");
    expect(getSymbolSearchAvailability({
      ...authenticatedTerminal,
      authenticated: false,
      status: "identity-unavailable",
    })).toBe("identity-unavailable");
    expect(getSymbolSearchAvailability({
      ...authenticatedTerminal,
      authenticated: false,
      status: "policy-rejected",
    })).toBe("policy-rejected");
  });
});

describe("symbol search lifecycle and keyboard selection", () => {
  it("debounces reads and aborts in-flight work on disposal", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const read = vi.fn((_query: string, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<string>(() => undefined);
    });
    const callbacks = { onStart: vi.fn(), onResult: vi.fn(), onError: vi.fn() };
    const cancel = scheduleSymbolSearch("NVDA", read, callbacks, 250);

    await vi.advanceTimersByTimeAsync(249);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledWith("NVDA", expect.any(AbortSignal));
    expect(callbacks.onStart).toHaveBeenCalledOnce();

    cancel();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not start a superseded query and ignores completion after cancellation", async () => {
    vi.useFakeTimers();
    let resolveRead: ((value: string) => void) | undefined;
    const read = vi.fn((_query: string, _signal: AbortSignal) => new Promise<string>((resolve) => {
      resolveRead = resolve;
    }));
    const callbacks = { onStart: vi.fn(), onResult: vi.fn(), onError: vi.fn() };
    const cancel = scheduleSymbolSearch("OLD", read, callbacks);
    const cancelBeforeStart = scheduleSymbolSearch("SUPERSEDED", read, callbacks);
    cancelBeforeStart();

    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(1);
    cancel();
    resolveRead?.("stale");
    await Promise.resolve();

    expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it("wraps keyboard movement over combined commands and symbol results", () => {
    expect(nextPaletteOptionIndex(0, 3, "next")).toBe(1);
    expect(nextPaletteOptionIndex(2, 3, "next")).toBe(0);
    expect(nextPaletteOptionIndex(0, 3, "previous")).toBe(2);
    expect(nextPaletteOptionIndex(0, 0, "next")).toBe(-1);
  });

  it("maps bounded client errors to explicit messages without exposing internals", () => {
    expect(symbolSearchErrorMessage(new WidgetDataReadError("rate-limited")))
      .toContain("rate limited");
    expect(symbolSearchErrorMessage(new WidgetDataReadError("concurrency-limited")))
      .toContain("busy");
    expect(symbolSearchErrorMessage(new WidgetDataReadError("request-failed")))
      .toContain("unavailable");
    expect(symbolSearchErrorMessage(new WidgetDataReadError("cancelled"))).toBeNull();
    expect(symbolSearchErrorMessage(new Error("provider response included details")))
      .toContain("unavailable");
  });
});
