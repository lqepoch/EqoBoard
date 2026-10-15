import {
  createWidgetHostContext,
  scopeWidgetHostContext,
  type WidgetHostServices,
} from "../widgets/sdk/host";
import type { WidgetHostContext } from "../widgets/sdk/contracts";
import type { WidgetActionId, WidgetActionMap } from "../widgets/sdk/actions";
import type { WidgetOperationDefinition } from "../widgets/sdk/data";

/**
 * Joins app-owned services to one widget's frozen registry capabilities before
 * the context crosses the renderer boundary.
 */
export function createWorkspaceWidgetHostContext<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition },
  TActions extends WidgetActionMap,
  TMarketSnapshot,
  TAllowedOperations extends keyof TOperations & string,
  TAllowedActions extends keyof TActions & WidgetActionId,
>(
  services: WidgetHostServices<TOperations, TActions, TMarketSnapshot>,
  lifecycle: WidgetHostContext<TOperations, TActions, TMarketSnapshot>["lifecycle"],
  capabilities: Readonly<{
    allowedReadOperations: readonly TAllowedOperations[];
    allowedActions: readonly TAllowedActions[];
  }>,
): WidgetHostContext<
  Pick<TOperations, TAllowedOperations>,
  Pick<TActions, TAllowedActions>,
  TMarketSnapshot
> {
  return scopeWidgetHostContext(createWidgetHostContext(services, lifecycle), capabilities);
}
