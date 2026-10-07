import {
  isOrderErrorContract,
  orderErrorFromResponse,
  unknownOrderError,
  type OrderErrorContract,
} from "./order-contract";

export class OrderRequestError extends Error {
  constructor(public readonly contract: OrderErrorContract) {
    super(contract.detail);
  }
}

export async function postOrderJson<T>(
  path: string,
  body: unknown,
  purpose: "preview" | "submit"
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    if (purpose === "submit") {
      const requestBody = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const previewId = typeof requestBody.preview_id === "string" ? requestBody.preview_id : undefined;
      throw new OrderRequestError(unknownOrderError(
        `No response was received${previewId ? ` for preview ${previewId}` : ""}. The order outcome is unknown; reconcile this operation and do not submit a new order ID.`
      ));
    }
    throw new Error("Order preview service is unavailable");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (purpose === "submit") {
      const contract = isOrderErrorContract(payload) ? payload : orderErrorFromResponse(payload, response.status);
      const requestBody = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const previewId = typeof requestBody.preview_id === "string" ? requestBody.preview_id : undefined;
      throw new OrderRequestError({
        ...contract,
        // Preserve the operation association when no stable broker ID was
        // returned. A preview id is for recovery correlation, never a retry id.
        client_order_id: contract.client_order_id,
        detail: contract.state === "unknown" && !contract.client_order_id && previewId &&
            !contract.detail.includes(previewId)
          ? `${contract.detail} Reconcile existing preview ${previewId}; do not submit a new order ID.`
          : contract.detail,
      });
    }
    const errorPayload = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new Error(typeof errorPayload.detail === "string" ? errorPayload.detail :
      typeof errorPayload.error === "string" ? errorPayload.error : `HTTP ${response.status}`);
  }
  if (!payload || typeof payload !== "object") {
    if (purpose === "submit") {
      const requestBody = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const previewId = typeof requestBody.preview_id === "string" ? requestBody.preview_id : undefined;
      throw new OrderRequestError(unknownOrderError(
        `The service returned an unreadable response${previewId ? ` for preview ${previewId}` : ""}. Reconcile the existing operation before retrying.`
      ));
    }
    throw new Error("Order preview response was invalid");
  }
  return payload as T;
}
