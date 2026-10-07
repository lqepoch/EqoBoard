"use client";

import { useState } from "react";
import { OrderRequestError, postOrderJson } from "@/lib/order-api";
import { unknownOrderError, type OrderOutcome } from "@/lib/order-contract";
import OrderOutcomePanel from "@/components/widgets/OrderOutcomePanel";

const previewId = "00000000-0000-4000-8000-000000000001";

/** Exercises the production submit helper and outcome panel without enabling Paper. */
export default function OrderOutcomeProbe() {
  const [outcome, setOutcome] = useState<OrderOutcome | null>(null);
  async function confirmExistingPreview() {
    try {
      await postOrderJson("/api/eqo/orders/submit", { preview_id: previewId, confirm: true }, "submit");
    } catch (error) {
      const contract = error instanceof OrderRequestError ? error.contract : unknownOrderError(
        error instanceof Error ? error.message : String(error),
      );
      setOutcome({ ...contract, operation_id: contract.client_order_id ?? previewId });
    }
  }

  return <section>
    <button onClick={() => void confirmExistingPreview()}>Confirm existing preview fixture</button>
    {outcome && <OrderOutcomePanel outcome={outcome} />}
  </section>;
}
