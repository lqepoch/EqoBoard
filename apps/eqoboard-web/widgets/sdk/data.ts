/**
 * A type-only boundary for the host's closed read-operation map. Concrete operation
 * IDs, inputs, outputs, decoders and transports belong to the data coordinator.
 */
export type WidgetOperationDefinition = Readonly<{
  input: unknown;
  output: unknown;
}>;

/** No read operations are available unless a feature's closed map is supplied explicitly. */
export type WidgetOperationMap = Readonly<Record<never, WidgetOperationDefinition>>;

export interface WidgetDataClient<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition } = WidgetOperationMap,
> {
  read<K extends keyof TOperations & string>(
    operationId: K,
    input: TOperations[K]["input"],
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<TOperations[K]["output"]>;
}

export type WidgetScheduledReadState<T> =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "ready"; value: T }>
  | Readonly<{
      status: "error";
      code: Extract<WidgetDataReadErrorCode, "rate-limited" | "request-failed">;
      retryAfterMs?: number;
    }>;

export type WidgetRefreshSchedulerOptions = Readonly<{ refreshIntervalMs: number }>;

/**
 * Per-widget scoped scheduler. The host binds manifest/global limits, lifecycle,
 * hidden-state behavior and transport before exposing this observer to a widget.
 */
export interface WidgetRefreshScheduler<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition } = WidgetOperationMap,
> {
  observe<K extends keyof TOperations & string>(
    operationId: K,
    input: TOperations[K]["input"],
    options: WidgetRefreshSchedulerOptions,
    listener: (state: WidgetScheduledReadState<TOperations[K]["output"]>) => void,
  ): () => void;
}

/** Read-only selector interface. Snapshot type comes from the shared host implementation. */
export interface WidgetMarketReader<TSnapshot = unknown> {
  getSnapshot(): TSnapshot;
  subscribe(listener: () => void): () => void;
}

export type WidgetDataReadErrorCode =
  | "suspended"
  | "disposed"
  | "hidden"
  | "rate-limited"
  | "concurrency-limited"
  | "cancelled"
  | "request-failed";

export class WidgetDataReadError extends Error {
  readonly code: WidgetDataReadErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: WidgetDataReadErrorCode, retryAfterMs?: number) {
    super(code);
    this.name = "WidgetDataReadError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

