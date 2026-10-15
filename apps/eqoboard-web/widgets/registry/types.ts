import type { ComponentType } from "react";
import type { WidgetActionId, WidgetActionMap, WidgetNoActionMap } from "../sdk/actions";
import type {
  ConfigParseResult,
  WidgetInstanceV1,
  WidgetManifestV1,
  WidgetProps,
  WidgetShortcut,
  WidgetSymbolBinding,
} from "../sdk/contracts";
import type { WidgetOperationDefinition, WidgetOperationMap } from "../sdk/data";

export type BuiltinProvenance = Readonly<{
  provenanceId: string;
  origin: "first-party" | "adapted-upstream";
  sourceRepository: string;
  sourcePath: string;
  sourceCommit: string | null;
  license: string | null;
  noticePath: string | null;
  auditReference: string;
}>;

export interface WidgetRegistration<
  C = unknown,
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition } = WidgetOperationMap,
  TActions extends WidgetActionMap = WidgetNoActionMap,
  TMarketSnapshot = unknown,
> {
  manifest: WidgetManifestV1;
  Component: ComponentType<WidgetProps<C, TOperations, TActions, TMarketSnapshot>>;
  /** Runtime per-instance read capability allowlist. Empty means no read dispatch. */
  allowedReadOperations: readonly (keyof TOperations & string)[];
  /** Runtime per-instance action capability allowlist. Empty means no action dispatch. */
  allowedActions: readonly (keyof TActions & WidgetActionId)[];
  parseConfig(value: unknown): ConfigParseResult<C>;
  /** Returns a fresh config object for a new workspace instance. */
  createDefaultConfig(): C;
  provenance: BuiltinProvenance;
}

/** Internal erased form after each static config parser has been retained in the entry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWidgetRegistration = WidgetRegistration<any, any, any, any>;

export type WidgetConfigParseResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; code: "config-invalid" | "unsupported-config-schema"; field?: string }>;

export type WidgetInstanceResolution =
  | Readonly<{
      status: "ready";
      registration: AnyWidgetRegistration;
      config: unknown;
      effectiveSymbolBinding?: WidgetSymbolBinding;
    }>
  | Readonly<{
      status:
        | "invalid-instance"
        | "unsupported-manifest"
        | "unsupported-manifest-version"
        | "unsupported-config-schema"
        | "unsupported-symbol-binding"
        | "config-invalid";
    }>;

export interface WidgetRegistry {
  get(manifestId: string): AnyWidgetRegistration | undefined;
  list(): readonly AnyWidgetRegistration[];
  getByShortcut(shortcut: WidgetShortcut): AnyWidgetRegistration | undefined;
  parseConfig(configSchemaId: string, value: unknown): WidgetConfigParseResult;
  /** Only a `ready` result may mount its static component. */
  resolveInstance(instance: WidgetInstanceV1): WidgetInstanceResolution;
}
