import type {
  WidgetHostContext,
  WidgetInstanceV1,
  WidgetManifestV1,
  WidgetResolvedInputs,
  WidgetRuntimeError,
} from "./contracts";
import {
  isWidgetActionId,
  type WidgetActionClient,
  type WidgetActionId,
  type WidgetActionInput,
  type WidgetActionMap,
  type WidgetActionOutput,
  type WidgetNoActionMap,
} from "./actions";
import { toWidgetRuntimeError } from "./errors";
import {
  WidgetDataReadError,
  type WidgetDataClient,
  type WidgetOperationDefinition,
  type WidgetOperationMap,
  type WidgetRefreshScheduler,
  type WidgetScheduledReadState,
} from "./data";
import { isWidgetSymbol } from "./symbols";

export type WidgetHostServices<
  TOperations extends {
    readonly [K in keyof TOperations]: WidgetOperationDefinition;
  } = WidgetOperationMap,
  TActions extends WidgetActionMap = WidgetNoActionMap,
  TMarketSnapshot = unknown,
> = Omit<WidgetHostContext<TOperations, TActions, TMarketSnapshot>, "lifecycle">;

export type WidgetHostCapabilities<
  TOperations extends {
    readonly [K in keyof TOperations]: WidgetOperationDefinition;
  } = WidgetOperationMap,
  TActions extends WidgetActionMap = WidgetNoActionMap,
  TAllowedOperations extends keyof TOperations & string = keyof TOperations & string,
  TAllowedActions extends keyof TActions & WidgetActionId = keyof TActions & WidgetActionId,
> = Readonly<{
  allowedReadOperations: readonly TAllowedOperations[];
  allowedActions: readonly TAllowedActions[];
}>;

/** Runtime registry view used after its feature-specific generic has been erased. */
export type WidgetHostCapabilityDeclaration = Readonly<{
  allowedReadOperations: readonly string[];
  allowedActions: readonly WidgetActionId[];
}>;

type CapabilityLists = Readonly<{
  readOperations: ReadonlySet<string>;
  actions: ReadonlySet<string>;
}>;

function readCapabilityList(
  value: unknown,
  isValidId: (value: string) => boolean,
): ReadonlySet<string> {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return new Set();
    const ownKeys = Reflect.ownKeys(value);
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value as object);
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value > 96 ||
      ownKeys.length !== lengthDescriptor.value + 1
    )
      return new Set();
    const length = lengthDescriptor.value;
    const ids: string[] = [];
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length)
        return new Set();
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        !isValidId(descriptor.value)
      )
        return new Set();
      ids.push(descriptor.value);
    }
    if (ids.length !== length || new Set(ids).size !== ids.length) return new Set();
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function readCapabilities(value: unknown): CapabilityLists {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { readOperations: new Set(), actions: new Set() };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { readOperations: new Set(), actions: new Set() };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const reads = descriptors.allowedReadOperations;
    const actions = descriptors.allowedActions;
    if (!reads || !("value" in reads) || !actions || !("value" in actions)) {
      return { readOperations: new Set(), actions: new Set() };
    }
    return {
      readOperations: readCapabilityList(reads.value, (id) =>
        /^[A-Za-z][A-Za-z0-9.-]{0,95}$/u.test(id),
      ),
      actions: readCapabilityList(actions.value, isWidgetActionId),
    };
  } catch {
    return { readOperations: new Set(), actions: new Set() };
  }
}

/** Builds an immutable per-instance context from services owned by the app host. */
export function createWidgetHostContext<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition },
  TActions extends WidgetActionMap,
  TMarketSnapshot,
>(
  services: WidgetHostServices<TOperations, TActions, TMarketSnapshot>,
  lifecycle: WidgetHostContext<TOperations, TActions, TMarketSnapshot>["lifecycle"],
): WidgetHostContext<TOperations, TActions, TMarketSnapshot> {
  return Object.freeze({
    ...services,
    lifecycle,
    reportError(error: WidgetRuntimeError) {
      const safe = toWidgetRuntimeError(error);
      try {
        services.reportError(safe);
      } catch {
        // A host reporting hook cannot interrupt a widget's render or data flow.
      }
    },
  });
}

/**
 * Binds read, refresh and action dispatch to one compiled registration. Missing
 * or malformed capability declarations become deny-all; the readonly market
 * snapshot, UI events and lifecycle remain host-owned ports.
 */
export function scopeWidgetHostContext<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition },
  TActions extends WidgetActionMap,
  TMarketSnapshot,
  TAllowedOperations extends keyof TOperations & string,
  TAllowedActions extends keyof TActions & WidgetActionId,
>(
  host: WidgetHostContext<TOperations, TActions, TMarketSnapshot>,
  capabilities: WidgetHostCapabilities<TOperations, TActions, TAllowedOperations, TAllowedActions>,
): WidgetHostContext<
  Pick<TOperations, TAllowedOperations>,
  Pick<TActions, TAllowedActions>,
  TMarketSnapshot
>;
export function scopeWidgetHostContext<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition },
  TActions extends WidgetActionMap,
  TMarketSnapshot,
>(
  host: WidgetHostContext<TOperations, TActions, TMarketSnapshot>,
  capabilities: WidgetHostCapabilityDeclaration,
): WidgetHostContext<TOperations, TActions, TMarketSnapshot>;
export function scopeWidgetHostContext<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition },
  TActions extends WidgetActionMap,
  TMarketSnapshot,
>(
  host: WidgetHostContext<TOperations, TActions, TMarketSnapshot>,
  capabilities: WidgetHostCapabilityDeclaration,
): WidgetHostContext<TOperations, TActions, TMarketSnapshot> {
  const { readOperations, actions: allowedActions } = readCapabilities(capabilities);
  const data: WidgetDataClient<TOperations> = Object.freeze({
    async read<K extends keyof TOperations & string>(
      operationId: K,
      input: TOperations[K]["input"],
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<TOperations[K]["output"]> {
      if (!readOperations.has(operationId)) throw new WidgetDataReadError("request-failed");
      return host.data.read(operationId, input, options);
    },
  });
  const refresh: WidgetRefreshScheduler<TOperations> = Object.freeze({
    observe<K extends keyof TOperations & string>(
      operationId: K,
      input: TOperations[K]["input"],
      options: Readonly<{ refreshIntervalMs: number }>,
      listener: (state: WidgetScheduledReadState<TOperations[K]["output"]>) => void,
    ): () => void {
      if (!readOperations.has(operationId)) {
        try {
          listener({ status: "error", code: "request-failed" });
        } catch {
          // Denials are local; an observer must not trigger any host dispatch.
        }
        return () => undefined;
      }
      return host.refresh.observe(operationId, input, options, listener);
    },
  });
  const actionClient: WidgetActionClient<TActions> = Object.freeze({
    async invoke<K extends keyof TActions & WidgetActionId>(
      actionId: K,
      input: WidgetActionInput<TActions, K>,
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<WidgetActionOutput<TActions, K>> {
      if (!allowedActions.has(actionId)) throw new WidgetDataReadError("request-failed");
      return host.actions.invoke(actionId, input, options);
    },
  });
  return Object.freeze({ ...host, data, actions: actionClient, refresh });
}

/** Resolve workspace inputs from the manifest declaration and persisted binding. */
export function resolveWidgetInputs(
  manifest: WidgetManifestV1,
  instance: WidgetInstanceV1,
  activeSymbol: string | null,
  watchlist: readonly string[],
): WidgetResolvedInputs {
  const inputs: { symbol?: string; watchlist?: readonly string[] } = {};
  if (
    manifest.inputs.some((input) => input.name === "symbol") &&
    manifest.symbolBinding === "active-or-fixed"
  ) {
    const selected =
      instance.symbolBinding?.mode === "fixed" ? instance.symbolBinding.symbol : activeSymbol;
    if (isWidgetSymbol(selected)) inputs.symbol = selected;
  }
  if (manifest.inputs.some((input) => input.name === "watchlist")) {
    inputs.watchlist = Object.freeze(watchlist.filter(isWidgetSymbol));
  }
  return Object.freeze(inputs);
}
