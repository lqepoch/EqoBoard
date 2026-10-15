import type {
  WidgetCommandIntentV1,
  WidgetCommandResult,
  WidgetEventBus,
  WidgetHostEventV1,
  WidgetCommandV1,
} from "./contracts";
import { isWidgetSymbol } from "./symbols";

export type WidgetEventBusHost = Readonly<{
  /** Per-instance clients stamp originInstanceId; widgets cannot spoof another origin. */
  forInstance(instanceId: string): WidgetEventBus;
  /** Host-only publication API; never placed in a widget's context. */
  publishActiveSymbol(symbol: string, originInstanceId: string | null): boolean;
}>;

export type WidgetEventBusOptions = Readonly<{
  onCommand(command: WidgetCommandV1): WidgetCommandResult;
}>;

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validSymbol(value: unknown): value is string {
  return isWidgetSymbol(value);
}

function validInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID.test(value);
}

export function parseWidgetCommandIntent(input: unknown): WidgetCommandIntentV1 | null {
  try {
    if (
      !isRecord(input) ||
      Reflect.ownKeys(input).length !== 2 ||
      !Object.hasOwn(input, "type") ||
      !Object.hasOwn(input, "symbol")
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const type = descriptors.type;
    const symbol = descriptors.symbol;
    if (
      !type ||
      !symbol ||
      !("value" in type) ||
      !("value" in symbol) ||
      !type.enumerable ||
      !symbol.enumerable ||
      type.value !== "active-symbol.select.v1" ||
      !validSymbol(symbol.value) ||
      typeof symbol.value !== "string"
    )
      return null;
    return Object.freeze({ type: "active-symbol.select.v1", symbol: symbol.value });
  } catch {
    return null;
  }
}

export function createWidgetEventBus(options: WidgetEventBusOptions): WidgetEventBusHost {
  const listeners = new Set<(event: WidgetHostEventV1) => void>();
  let sequence = 0;

  return Object.freeze({
    forInstance(instanceId: string): WidgetEventBus {
      const validInstance = validInstanceId(instanceId);
      return Object.freeze({
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispatch(input) {
          if (!validInstance) return { accepted: false, reason: "invalid-command" };
          const intent = parseWidgetCommandIntent(input);
          if (!intent) return { accepted: false, reason: "invalid-command" };
          try {
            return options.onCommand(Object.freeze({ ...intent, originInstanceId: instanceId }));
          } catch {
            return { accepted: false, reason: "host-rejected" };
          }
        },
      });
    },
    publishActiveSymbol(symbol: string, originInstanceId: string | null) {
      if (!validSymbol(symbol) || (originInstanceId !== null && !validInstanceId(originInstanceId)))
        return false;
      sequence += 1;
      const event: WidgetHostEventV1 = Object.freeze({
        type: "active-symbol.changed.v1",
        symbol,
        originInstanceId,
        sequence,
      });
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // One host listener cannot block other widgets from observing workspace state.
        }
      }
      return true;
    },
  });
}
