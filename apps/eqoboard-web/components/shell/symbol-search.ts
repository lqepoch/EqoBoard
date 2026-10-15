import { WidgetDataReadError } from "@/widgets/sdk/data";
import type { AuthUiSnapshot } from "@/lib/contracts/auth";

export const SYMBOL_SEARCH_DEBOUNCE_MS = 250;
export const SYMBOL_SEARCH_MAX_QUERY_LENGTH = 64;

export type SymbolSearchAvailability =
  | "ready"
  | "identity-unavailable"
  | "policy-rejected"
  | "sign-in-required"
  | "terminal-runtime-required"
  | "research-permission-required";

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeSymbolSearchQuery(value: string): string | null {
  if (containsControlCharacters(value)) return null;
  const query = value.trim();
  if (query.length < 1 || query.length > SYMBOL_SEARCH_MAX_QUERY_LENGTH) return null;
  return query;
}

export function getSymbolSearchQueryIssue(value: string): "too-long" | "control-characters" | null {
  if (value.trim().length > SYMBOL_SEARCH_MAX_QUERY_LENGTH) return "too-long";
  if (containsControlCharacters(value)) return "control-characters";
  return null;
}

export function getSymbolSearchAvailability(auth: AuthUiSnapshot): SymbolSearchAvailability {
  if (auth.status === "identity-unavailable") return "identity-unavailable";
  if (auth.status === "policy-rejected") return "policy-rejected";
  if (!auth.authenticated || auth.status !== "authenticated") return "sign-in-required";
  if (auth.runtimeMode !== "terminal") return "terminal-runtime-required";
  if (!auth.permissions.includes("research:read")) return "research-permission-required";
  return "ready";
}

export function symbolSearchErrorMessage(error: unknown): string | null {
  if (error instanceof WidgetDataReadError && error.code === "cancelled") return null;
  if (error instanceof WidgetDataReadError && error.code === "rate-limited") {
    return "Symbol search is rate limited. Wait a moment and try again.";
  }
  if (error instanceof WidgetDataReadError && error.code === "concurrency-limited") {
    return "Symbol search is busy. Try again shortly.";
  }
  return "Symbol search is unavailable. Try again later.";
}

export function nextPaletteOptionIndex(
  current: number,
  count: number,
  direction: "next" | "previous",
): number {
  if (!Number.isSafeInteger(count) || count <= 0) return -1;
  const index = Number.isSafeInteger(current) && current >= 0 && current < count ? current : 0;
  return direction === "next" ? (index + 1) % count : (index - 1 + count) % count;
}

export type SymbolSearchSchedule<Value> = Readonly<{
  onStart: () => void;
  onResult: (value: Value) => void;
  onError: (error: unknown) => void;
}>;

/** Debounces a bounded read and suppresses every completion after cancellation. */
export function scheduleSymbolSearch<Value>(
  query: string,
  read: (query: string, signal: AbortSignal) => Promise<Value>,
  callbacks: SymbolSearchSchedule<Value>,
  delayMs = SYMBOL_SEARCH_DEBOUNCE_MS,
): () => void {
  const controller = new AbortController();
  let active = true;
  const timeout = setTimeout(
    () => {
      if (!active) return;
      callbacks.onStart();
      void read(query, controller.signal).then(
        (value) => {
          if (active && !controller.signal.aborted) callbacks.onResult(value);
        },
        (error: unknown) => {
          if (active && !controller.signal.aborted) callbacks.onError(error);
        },
      );
    },
    Math.max(0, Math.min(delayMs, 1000)),
  );

  return () => {
    if (!active) return;
    active = false;
    clearTimeout(timeout);
    controller.abort();
  };
}
