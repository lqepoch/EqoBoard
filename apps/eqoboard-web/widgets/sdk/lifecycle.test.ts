import { describe, expect, it, vi } from "vitest";
import { createWidgetLifecycleController } from "./lifecycle";

describe("widget lifecycle", () => {
  it("aborts a suspended generation and creates a fresh signal on resume", () => {
    const lifecycle = createWidgetLifecycleController();
    const first = lifecycle.getSnapshot();
    const observer = vi.fn();
    lifecycle.subscribe(observer);

    lifecycle.suspend();
    expect(first.signal.aborted).toBe(true);
    expect(lifecycle.getSnapshot().phase).toBe("suspended");
    lifecycle.resume();

    const resumed = lifecycle.getSnapshot();
    expect(resumed.phase).toBe("active");
    expect(resumed.generation).toBe(first.generation + 1);
    expect(resumed.signal).not.toBe(first.signal);
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("disposes idempotently and runs all cleanup even when one cleanup throws", () => {
    const lifecycle = createWidgetLifecycleController();
    const cleanupOne = vi.fn(() => { throw new Error("private detail"); });
    const cleanupTwo = vi.fn();
    lifecycle.onDispose(cleanupOne);
    lifecycle.onDispose(cleanupTwo);
    lifecycle.dispose();
    lifecycle.dispose();

    expect(lifecycle.getSnapshot().phase).toBe("disposed");
    expect(lifecycle.getSnapshot().signal.aborted).toBe(true);
    expect(cleanupOne).toHaveBeenCalledTimes(1);
    expect(cleanupTwo).toHaveBeenCalledTimes(1);
    const cleanupAfterDispose = vi.fn();
    lifecycle.onDispose(cleanupAfterDispose);
    expect(cleanupAfterDispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.isCurrent(1)).toBe(false);
  });
});

