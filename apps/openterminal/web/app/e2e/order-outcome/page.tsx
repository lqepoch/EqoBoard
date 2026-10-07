import { notFound } from "next/navigation";
import OrderOutcomeProbe from "@/e2e/order-outcome-probe";

/** Development-only browser fixture; unavailable in every production build. */
export default function OrderOutcomeFixturePage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <main className="p-4"><h1>Order outcome browser fixture</h1><OrderOutcomeProbe /></main>;
}
