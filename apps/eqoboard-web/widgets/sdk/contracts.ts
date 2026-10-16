import type { Permission } from "../../lib/contracts/auth";
import type { WidgetActionClient, WidgetActionMap, WidgetNoActionMap } from "./actions";
import type {
  WidgetDataClient,
  WidgetMarketReader,
  WidgetOperationDefinition,
  WidgetOperationMap,
} from "./data";
import type { WidgetRefreshScheduler } from "./refresh";

/** The SDK version is independent of any financial wire-contract version. */
export const WIDGET_SDK_VERSION = 1 as const;

export type WidgetId = string;

/** Bounded JSON configuration only; never a financial or provider wire model. */
export type WidgetJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly WidgetJsonValueV1[]
  | { readonly [key: string]: WidgetJsonValueV1 };

export type WidgetCategory = "market" | "research" | "portfolio" | "utility";

export type WidgetSymbolBinding =
  | Readonly<{ mode: "active" }>
  | Readonly<{ mode: "fixed"; symbol: string }>;

export type WidgetInputV1 =
  | Readonly<{ name: "symbol"; kind: "symbol"; source: "symbol-binding"; required: true }>
  | Readonly<{
      name: "watchlist";
      kind: "symbol-list";
      source: "workspace.watchlist";
      required: true;
    }>;

export type WidgetRefreshPolicyV1 =
  | Readonly<{ mode: "none" }>
  | Readonly<{ mode: "shared-market" }>
  | Readonly<{
      mode: "poll";
      minIntervalMs: number;
      maxRequestsPerMinute: number;
      maxConcurrentRequests: 1;
      whenHidden: "pause" | "continue";
    }>;

export type WidgetShortcut = `Alt+${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/** Runtime-validated, data-only declaration. It cannot provide executable code or URLs. */
export type WidgetManifestV1 = Readonly<{
  manifestVersion: 1;
  sdkVersion: 1;
  id: WidgetId;
  version: string;
  title: string;
  description: string;
  category: WidgetCategory;
  rendererId: string;
  configSchemaId: string;
  defaultSize: Readonly<{
    w: number;
    h: number;
    minW: number;
    minH: number;
    maxW: number;
    maxH: number;
  }>;
  inputs: readonly WidgetInputV1[];
  requiredPermissions: readonly Permission[];
  refresh: WidgetRefreshPolicyV1;
  symbolBinding: "unsupported" | "active-or-fixed";
  provenanceId: string;
  provenancePolicy: "surface-response-evidence" | "no-market-data";
  shortcut?: WidgetShortcut;
}>;

/** Persisted identity. Unknown manifest/schema IDs remain valid data for inert rendering. */
export type WidgetInstanceV1 = Readonly<{
  instanceId: string;
  manifestId: WidgetId;
  manifestVersion: string;
  configSchemaId: string;
  config: WidgetJsonValueV1;
  symbolBinding?: WidgetSymbolBinding;
}>;

export type WidgetValidationErrorCode =
  | "invalid-shape"
  | "unknown-field"
  | "invalid-value"
  | "unsupported-version"
  | "too-large"
  | "duplicate-value"
  | "unknown-permission";

export type WidgetValidationIssue = Readonly<{
  code: WidgetValidationErrorCode;
  path: string;
  message: string;
}>;

export type WidgetParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly WidgetValidationIssue[] }>;

export type ConfigParseResult<C> =
  | Readonly<{ ok: true; value: C }>
  | Readonly<{ ok: false; code: "config-invalid"; field?: string }>;

export type WidgetConfigErrorCode = "config-invalid" | "unsupported-config-schema";

export type WidgetAuthorizationView = Readonly<{
  authenticated: boolean;
  permissions: readonly Permission[];
}>;

export type WidgetResolvedInputs = Readonly<{
  symbol?: string;
  watchlist?: readonly string[];
}>;

export type WidgetLifecyclePhase = "active" | "suspended" | "disposed";

export type WidgetLifecycleSnapshot = Readonly<{
  phase: WidgetLifecyclePhase;
  generation: number;
  signal: AbortSignal;
}>;

export interface WidgetLifecycle {
  getSnapshot(): WidgetLifecycleSnapshot;
  subscribe(listener: () => void): () => void;
  onDispose(cleanup: () => void): () => void;
}

/** UI/workspace-only event payloads. These are not market stream events. */
export type WidgetHostEventV1 = Readonly<{
  type: "active-symbol.changed.v1";
  symbol: string;
  originInstanceId: string | null;
  sequence: number;
}>;

export type WidgetCommandIntentV1 = Readonly<{
  type: "active-symbol.select.v1";
  symbol: string;
}>;

export type WidgetCommandV1 = Readonly<{
  type: "active-symbol.select.v1";
  symbol: string;
  originInstanceId: string;
}>;

export type WidgetCommandResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: "invalid-command" | "invalid-symbol" | "host-rejected";
    }>;

/** Widgets can listen and request commands; only the host can publish events. */
export interface WidgetEventBus {
  subscribe(listener: (event: WidgetHostEventV1) => void): () => void;
  dispatch(command: WidgetCommandIntentV1): WidgetCommandResult;
}

export interface WidgetHostContext<
  TOperations extends {
    readonly [K in keyof TOperations]: WidgetOperationDefinition;
  } = WidgetOperationMap,
  TActions extends WidgetActionMap = WidgetNoActionMap,
  TMarketSnapshot = unknown,
> {
  /** Visibility hint only. The server rechecks authorization on every request. */
  auth: WidgetAuthorizationView;
  lifecycle: WidgetLifecycle;
  events: WidgetEventBus;
  data: WidgetDataClient<TOperations>;
  actions: WidgetActionClient<TActions>;
  refresh: WidgetRefreshScheduler<TOperations>;
  market: WidgetMarketReader<TMarketSnapshot>;
  reportError(error: WidgetRuntimeError): void;
}

export interface WidgetProps<
  C,
  TOperations extends {
    readonly [K in keyof TOperations]: WidgetOperationDefinition;
  } = WidgetOperationMap,
  TActions extends WidgetActionMap = WidgetNoActionMap,
  TMarketSnapshot = unknown,
> {
  instance: WidgetInstanceV1;
  config: Readonly<C>;
  inputs: WidgetResolvedInputs;
  host: WidgetHostContext<TOperations, TActions, TMarketSnapshot>;
  /** The host validates this against the registration schema before persisting it. */
  onConfigChange(nextConfig: C): void;
}

export type WidgetRuntimeError =
  | Readonly<{
      code: "manifest-invalid" | "unsupported-version" | "config-invalid";
      retryable: false;
    }>
  | Readonly<{ code: "permission-missing"; permission: Permission; retryable: false }>
  | Readonly<{ code: "rate-limited"; retryable: true; retryAfterMs?: number }>
  | Readonly<{ code: "data-unavailable" | "request-failed"; retryable: boolean }>
  | Readonly<{ code: "render-failed"; retryable: false }>
  | Readonly<{ code: "cancelled"; retryable: false }>;
