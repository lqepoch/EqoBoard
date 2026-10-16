import {
  createWidgetHostContext,
  scopeWidgetHostContext,
  type WidgetHostCapabilityDeclaration,
  type WidgetHostServices,
} from "../widgets/sdk/host";
import type { WidgetHostContext } from "../widgets/sdk/contracts";
import type { WidgetActionMap } from "../widgets/sdk/actions";
import type { WidgetOperationDefinition } from "../widgets/sdk/data";

/**
 * Joins app-owned services to one widget's frozen registry capabilities before
 * the context crosses the renderer boundary.
 */
export function createWorkspaceWidgetHostContext<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition },
  TActions extends WidgetActionMap,
  TMarketSnapshot,
>(
  services: WidgetHostServices<TOperations, TActions, TMarketSnapshot>,
  lifecycle: WidgetHostContext<TOperations, TActions, TMarketSnapshot>["lifecycle"],
  capabilities: WidgetHostCapabilityDeclaration,
): WidgetHostContext<TOperations, TActions, TMarketSnapshot> {
  return scopeWidgetHostContext(createWidgetHostContext(services, lifecycle), capabilities);
}
