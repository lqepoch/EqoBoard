import type { OrderOutcome } from "../../lib/order-contract";

export default function OrderOutcomePanel({ outcome }: { outcome: OrderOutcome }) {
  const accepted = outcome.state === "accepted";
  const needsRecovery = outcome.recovery_required || outcome.state === "unknown";
  return <div role="alert" data-testid="order-outcome" className={`border p-2 mt-2 ${
    accepted ? "border-[#375b4b] bg-[#10251c]" : "border-[#70434a] bg-[#241316]"
  }`}>
    <div className={`font-semibold ${accepted ? "up" : "down"}`}>Order outcome: {outcome.state.toUpperCase()}</div>
    <div>{outcome.detail}</div>
    <div className="font-mono">Operation ID: {outcome.operation_id}</div>
    {outcome.client_order_id && <div className="font-mono">Client order ID: {outcome.client_order_id}</div>}
    {accepted && <div className="amber">Adapter acceptance does not mean the order filled.</div>}
    {needsRecovery && <div className="amber">Keep this ID for reconciliation. Do not submit a replacement order.</div>}
  </div>;
}
