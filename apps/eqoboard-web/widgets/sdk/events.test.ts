import { describe, expect, it, vi } from "vitest";
import { createWidgetEventBus, parseWidgetCommandIntent } from "./events";

const instanceId = "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d";

describe("widget host event bus", () => {
  it("validates commands and only lets the host publish sequenced workspace events", () => {
    const onCommand = vi.fn(() => ({ accepted: true as const }));
    const bus = createWidgetEventBus({ onCommand });
    const client = bus.forInstance(instanceId);
    const listener = vi.fn();
    client.subscribe(listener);

    expect(parseWidgetCommandIntent({ type: "active-symbol.select.v1", symbol: "SPY" }))
      .not.toBeNull();
    expect(client.dispatch({ type: "active-symbol.select.v1", symbol: "SPY" }))
      .toEqual({ accepted: true });
    expect(client.dispatch({ type: "active-symbol.select.v1", symbol: "spy" }))
      .toEqual({ accepted: false, reason: "invalid-command" });
    expect(client.dispatch({ type: "market.quote.v1", symbol: "SPY" } as never))
      .toEqual({ accepted: false, reason: "invalid-command" });
    expect(client.dispatch({ type: "active-symbol.select.v1", symbol: "QQQ", originInstanceId: "forged" } as never))
      .toEqual({ accepted: false, reason: "invalid-command" });
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({ type: "active-symbol.select.v1", symbol: "SPY", originInstanceId: instanceId });
    expect("publishActiveSymbol" in client).toBe(false);

    expect(bus.publishActiveSymbol("SPY", instanceId)).toBe(true);
    expect(bus.publishActiveSymbol("A".repeat(25), null)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual({
      type: "active-symbol.changed.v1",
      symbol: "SPY",
      originInstanceId: instanceId,
      sequence: 1,
    });
  });

  it("fails closed when a command proxy throws during inspection", () => {
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("must not escape event validation");
      },
    });
    expect(parseWidgetCommandIntent(hostile)).toBeNull();
  });
});

