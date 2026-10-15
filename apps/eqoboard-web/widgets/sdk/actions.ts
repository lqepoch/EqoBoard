/** Closed, host-mediated actions. Portfolio IDs mutate the user's manual ledger only; none touch broker orders. */
export type WidgetActionId =
  | "research.ai"
  | "orders.preview.vertical"
  | "portfolio.create"
  | "portfolio.delete"
  | "portfolio.transaction.create"
  | "portfolio.transaction.delete";
export const WIDGET_ACTION_IDS = Object.freeze([
  "research.ai",
  "orders.preview.vertical",
  "portfolio.create",
  "portfolio.delete",
  "portfolio.transaction.create",
  "portfolio.transaction.delete",
] as const);

export function isWidgetActionId(value: unknown): value is WidgetActionId {
  return typeof value === "string" && (WIDGET_ACTION_IDS as readonly string[]).includes(value);
}

export type WidgetActionDefinition = Readonly<{
  input: unknown;
  output: unknown;
}>;

/** Feature owners may supply precise schemas for only the closed action IDs above. */
export type WidgetActionMap = Readonly<Partial<Record<WidgetActionId, WidgetActionDefinition>>>;
/** Widgets expose no action IDs unless their registration supplies a feature-owned map. */
export type WidgetNoActionMap = Readonly<Record<never, WidgetActionDefinition>>;

export interface WidgetActionClient<TActions extends WidgetActionMap = WidgetNoActionMap> {
  invoke<K extends keyof TActions & WidgetActionId>(
    actionId: K,
    input: TActions[K]["input"],
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<TActions[K]["output"]>;
}

