export type OrderErrorState = "unknown" | "rejected" | "blocked";

export type OrderErrorContract = {
  state: OrderErrorState;
  client_order_id?: string;
  retryable: false;
  recovery_required: boolean;
  detail: string;
};

export type LockedOrderIntent = {
  broker: "alpaca" | "ibkr" | "schwab";
  environment: "paper" | "live";
  kind: "vertical";
  symbol: string | null;
  quantity: number;
  limit_price: number;
  net_effect: "debit" | "credit";
  legs: Array<{ symbol: string; side: "buy" | "sell" }>;
  account_id?: string | null;
};

export type LockedPreview = {
  preview_id: string;
  expires_at: string;
  estimated_max_loss: number;
  currency: string;
  intent: LockedOrderIntent;
};

export type OrderOutcome = {
  state: OrderErrorState | "accepted";
  operation_id: string;
  client_order_id?: string;
  retryable: false;
  recovery_required: boolean;
  detail: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const occ = /^[A-Z0-9]{1,6}\d{6}[CP]\d{8}$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function isLockedPreview(value: unknown): value is LockedPreview {
  if (!value || typeof value !== "object") return false;
  const preview = value as Partial<LockedPreview>;
  const intent = preview.intent;
  if (typeof preview.preview_id !== "string" || !uuid.test(preview.preview_id) ||
      typeof preview.expires_at !== "string" || !rfc3339.test(preview.expires_at) ||
      !Number.isFinite(Date.parse(preview.expires_at)) ||
      typeof preview.estimated_max_loss !== "number" || !Number.isFinite(preview.estimated_max_loss) ||
      preview.estimated_max_loss < 0 || typeof preview.currency !== "string" || !/^[A-Z]{3}$/.test(preview.currency) ||
      !intent || typeof intent !== "object") return false;

  return (intent.broker === "alpaca" || intent.broker === "ibkr" || intent.broker === "schwab") &&
    (intent.environment === "paper" || intent.environment === "live") &&
    intent.kind === "vertical" && intent.symbol === null &&
    Number.isSafeInteger(intent.quantity) && intent.quantity > 0 &&
    Number.isFinite(intent.limit_price) && intent.limit_price > 0 &&
    (intent.net_effect === "debit" || intent.net_effect === "credit") &&
    Array.isArray(intent.legs) && intent.legs.length === 2 &&
    intent.legs.every((leg) => leg && typeof leg === "object" &&
      typeof leg.symbol === "string" && occ.test(leg.symbol) &&
      (leg.side === "buy" || leg.side === "sell")) &&
    intent.legs[0].symbol !== intent.legs[1].symbol &&
    intent.legs[0].side !== intent.legs[1].side &&
    (intent.account_id === undefined || intent.account_id === null || typeof intent.account_id === "string");
}

export function isOrderErrorContract(value: unknown): value is OrderErrorContract {
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<OrderErrorContract>;
  return (error.state === "unknown" || error.state === "rejected" || error.state === "blocked") &&
    error.retryable === false && typeof error.recovery_required === "boolean" &&
    typeof error.detail === "string" &&
    (error.client_order_id === undefined || typeof error.client_order_id === "string");
}

export function unknownOrderError(detail: string, clientOrderId?: string): OrderErrorContract {
  return {
    state: "unknown",
    client_order_id: clientOrderId,
    retryable: false,
    recovery_required: true,
    detail,
  };
}

export function orderErrorFromResponse(payload: unknown, status: number): OrderErrorContract {
  if (isOrderErrorContract(payload)) return payload;
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  // An untyped HTTP failure does not prove that a submission was rejected:
  // the adapter may have accepted it before an intermediary lost the reply.
  // Only explicit authorization failures are safe to call blocked. All other
  // untyped submit failures remain UNKNOWN and must be reconciled by ID.
  const state: OrderErrorState = status === 401 || status === 403 ? "blocked" : "unknown";
  const detail = typeof body.detail === "string" ? body.detail :
    typeof body.error === "string" ? body.error : `Order submission returned HTTP ${status}`;
  return {
    state,
    client_order_id: typeof body.client_order_id === "string" ? body.client_order_id : undefined,
    retryable: false,
    recovery_required: true,
    detail,
  };
}

export function unknownOrderOutcome(detail: string, operationId: string): OrderOutcome {
  return {
    ...unknownOrderError(detail),
    operation_id: operationId,
  };
}
