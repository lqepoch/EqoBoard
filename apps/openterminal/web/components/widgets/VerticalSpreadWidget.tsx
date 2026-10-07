"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt } from "../../lib/api";
import { OrderRequestError, postOrderJson } from "../../lib/order-api";
import {
  isLockedPreview,
  orderIntentMatches,
  type LockedOrderIntent,
  type LockedPreview,
  type OrderErrorContract,
  type OrderOutcome,
} from "../../lib/order-contract";
import { useTerminal, useWidgetSymbol, type WidgetInstance, type OptionLeg } from "../../store/terminal";
import OrderOutcomePanel from "./OrderOutcomePanel";

type Broker = "alpaca" | "ibkr" | "schwab";
type Status = {
  brokerCapabilities?: Partial<Record<Broker, { paper?: { enabled?: boolean; implementation?: string } }>>;
};
type NetEffect = "debit" | "credit";
type FormState = { broker: Broker; quantity: string; limit: string; netEffect: NetEffect };
type PreviewState = LockedPreview & { fingerprint: string };

const initialForm: FormState = { broker: "ibkr", quantity: "1", limit: "", netEffect: "debit" };
const isBroker = (value: unknown): value is Broker => value === "alpaca" || value === "ibkr" || value === "schwab";
function paperSubmissionAvailable(): boolean {
  return false;
}

function makeIntent(form: FormState, legs: OptionLeg[]): LockedOrderIntent {
  return {
    broker: form.broker,
    environment: "paper",
    kind: "vertical",
    symbol: null,
    quantity: Number(form.quantity),
    limit_price: Number(form.limit),
    net_effect: form.netEffect,
    legs: legs.map(({ symbol, side }) => ({ symbol, side })),
  };
}

function intentFingerprint(form: FormState, legs: OptionLeg[]): string {
  const intent = makeIntent(form, legs);
  return JSON.stringify([
    intent.broker,
    intent.environment,
    intent.kind,
    intent.symbol,
    intent.quantity,
    intent.limit_price,
    intent.net_effect,
    intent.legs.map((leg) => [leg.symbol, leg.side]),
  ]);
}

function lockedLegLabel(leg: LockedOrderIntent["legs"][number]): string {
  return `${leg.side.toUpperCase()} ${leg.symbol}`;
}

export default function VerticalSpreadWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const legs = useTerminal((state) => state.optionLegs);
  const clear = useTerminal((state) => state.clearOptionLegs);
  const setSide = useTerminal((state) => state.setOptionLegSide);
  const [form, setForm] = useState<FormState>(initialForm);
  const formRef = useRef(form);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OrderOutcome | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);
  const activePreviewRequests = useRef(0);
  const { data: status } = useQuery({
    queryKey: ["status"], queryFn: () => apiGet<Status>("/api/status"), refetchInterval: 30_000,
  });
  const fingerprint = intentFingerprint(form, legs);

  function invalidateIntent() {
    generation.current += 1;
    setPreview(null);
    setPreviewError(null);
    setOutcome((current) => current?.state === "unknown" && current.recovery_required ? current : null);
  }

  function updateForm(patch: Partial<FormState>) {
    const next = { ...formRef.current, ...patch };
    formRef.current = next;
    invalidateIntent();
    setForm(next);
  }

  useEffect(() => {
    const unsubscribe = useTerminal.subscribe((state, previous) => {
      if (state.optionLegs !== previous.optionLegs) invalidateIntent();
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!preview) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [preview]);

  const validInput = useMemo(() => legs.length === 2 && legs[0].side !== legs[1].side &&
    Number.isInteger(Number(form.quantity)) && Number(form.quantity) > 0 &&
    Number.isFinite(Number(form.limit)) && Number(form.limit) > 0,
  [legs, form.quantity, form.limit]);
  const activePreview = preview?.fingerprint === fingerprint ? preview : null;
  const expirationMs = activePreview ? Date.parse(activePreview.expires_at) : Number.NaN;
  const expired = !activePreview || !Number.isFinite(expirationMs) || now >= expirationMs;
  const remainingSeconds = !expired && activePreview ? Math.max(0, Math.ceil((expirationMs - now) / 1000)) : 0;

  async function createPreview() {
    if (!validInput || activePreviewRequests.current > 0 ||
        (outcome?.state === "unknown" && outcome.recovery_required)) return;
    const formSnapshot = formRef.current;
    const legsSnapshot = useTerminal.getState().optionLegs;
    const requestFingerprint = intentFingerprint(formSnapshot, legsSnapshot);
    const requestGeneration = ++generation.current;
    setPreview(null);
    setPreviewError(null);
    setOutcome(null);
    activePreviewRequests.current += 1;
    setPreviewing(true);
    try {
      const requestedIntent = makeIntent(formSnapshot, legsSnapshot);
      const result = await postOrderJson<{ preview?: unknown }>(
        "/api/eqo/orders/preview", requestedIntent, "preview");
      if (!isLockedPreview(result.preview) || !orderIntentMatches(result.preview.intent, requestedIntent)) {
        throw new Error("Order preview response did not lock the submitted order intent");
      }
      if (requestGeneration !== generation.current ||
          requestFingerprint !== intentFingerprint(formRef.current, useTerminal.getState().optionLegs)) return;
      setPreview({ ...result.preview, fingerprint: requestFingerprint });
      setNow(Date.now());
    } catch (error) {
      if (requestGeneration !== generation.current ||
          requestFingerprint !== intentFingerprint(formRef.current, useTerminal.getState().optionLegs)) return;
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      activePreviewRequests.current = Math.max(0, activePreviewRequests.current - 1);
      setPreviewing(activePreviewRequests.current > 0);
    }
  }

  async function submitPaper() {
    // The durable preview -> order/outbox ledger, bound account identity, and
    // verified atomic-paper capability are not available in this release.
    // Keep this guard even if a future status endpoint reports executionMode=paper.
    if (!paperSubmissionAvailable() || !activePreview || expired || outcome) return;
    const operationId = activePreview.preview_id;
    try {
      const result = await postOrderJson<{ client_order_id: string; ack: { status: string } }>(
        "/api/eqo/orders/submit", { preview_id: activePreview.preview_id, confirm: true }, "submit");
      setOutcome({
        state: "accepted", client_order_id: result.client_order_id, operation_id: result.client_order_id,
        retryable: false, recovery_required: true,
        detail: `The adapter reported ${result.ack.status}; execution state requires reconciliation.`,
      });
    } catch (error) {
      const contract: OrderErrorContract = error instanceof OrderRequestError ? error.contract : {
        state: "unknown", retryable: false, recovery_required: true,
        detail: error instanceof Error ? error.message : String(error),
      };
      setOutcome({ ...contract, operation_id: contract.client_order_id ?? operationId });
    }
  }

  const submitBlockedReason = "Paper submission is blocked until the preview ledger, account binding, outbox, and atomic broker capability are verified.";

  return <div className="h-full overflow-auto p-2 text-[11px]">
    <div className="flex justify-between items-center mb-2">
      <span className="amber font-semibold">{symbol} VERTICAL SPREAD</span>
      <span className="down">PAPER SUBMISSION BLOCKED</span>
    </div>
    {[0, 1].map((index) => <div key={index} className="border border-[#333] bg-[#121212] p-2 mb-1 flex gap-2 items-center">
      <span className="dim">{String(index + 1).padStart(2, "0")}</span>
      <div className="flex-1 min-w-0">
        <div className="truncate font-mono">{legs[index]?.symbol ?? "Select a contract in Option Chain"}</div>
        <div className="dim text-[9px]">{legs[index] ? `${legs[index].right.toUpperCase()} · strike ${fmt(legs[index].strike, 1)}` : "same expiry / same right required"}</div>
      </div>
      {legs[index] && <select aria-label={`Leg ${index + 1} side`} value={legs[index].side}
        onChange={(event) => setSide(legs[index].symbol, event.target.value as OptionLeg["side"])}>
        <option value="buy">BUY</option><option value="sell">SELL</option>
      </select>}
    </div>)}
    <button className="term-btn w-full mb-2" onClick={clear}>CLEAR LEGS</button>
    <div className="grid grid-cols-2 gap-2">
      <label className="dim">Broker<select aria-label="Broker" className="w-full mt-1" value={form.broker}
        onChange={(event) => isBroker(event.target.value) && updateForm({ broker: event.target.value })}>
        {(["alpaca", "ibkr", "schwab"] as Broker[]).map((broker) => <option key={broker} value={broker}>
          {broker.toUpperCase()} · {status?.brokerCapabilities?.[broker]?.paper?.enabled === true
            ? "Paper enabled" : "Paper disabled"}
        </option>)}
      </select></label>
      <label className="dim">Qty<input aria-label="Quantity" className="w-full mt-1" type="number" min="1" step="1"
        value={form.quantity} onChange={(event) => updateForm({ quantity: event.target.value })} /></label>
      <label className="dim">Net<select aria-label="Net effect" className="w-full mt-1" value={form.netEffect}
        onChange={(event) => updateForm({ netEffect: event.target.value as NetEffect })}>
        <option value="debit">DEBIT</option><option value="credit">CREDIT</option>
      </select></label>
      <label className="dim">Limit / share<input aria-label="Limit price" className="w-full mt-1" type="number" min="0.01" step="0.01"
        value={form.limit} onChange={(event) => updateForm({ limit: event.target.value })} /></label>
    </div>
    {previewError && <div role="alert" className="down mt-2">{previewError}</div>}
    {outcome && <OrderOutcomePanel outcome={outcome} />}
    {activePreview && <div data-testid="locked-preview" className="border border-[#375b4b] bg-[#10251c] p-2 mt-2">
      <div className="flex justify-between"><span className="dim">Server-locked intent</span><b>{activePreview.intent.broker.toUpperCase()} · {activePreview.intent.environment.toUpperCase()}</b></div>
      <div className="flex justify-between"><span className="dim">Account</span><span>{activePreview.intent.account_id ?? "Not bound"}</span></div>
      <div className="flex justify-between"><span className="dim">Legs</span><span className="text-right">{activePreview.intent.legs.map(lockedLegLabel).join(" / ")}</span></div>
      <div className="flex justify-between"><span className="dim">Quantity · Net</span><span>{activePreview.intent.quantity} · {activePreview.intent.net_effect.toUpperCase()}</span></div>
      <div className="flex justify-between"><span className="dim">Limit / share</span><span>{activePreview.currency} {fmt(activePreview.intent.limit_price)}</span></div>
      <div className="flex justify-between"><span className="dim">Maximum loss</span><b>{activePreview.currency} {fmt(activePreview.estimated_max_loss)}</b></div>
      <div className="flex justify-between"><span className="dim">Expires</span><span>{expired ? "EXPIRED" : `${remainingSeconds}s · ${activePreview.expires_at}`}</span></div>
      <div className="flex justify-between"><span className="dim">Preview ID</span><code>{activePreview.preview_id}</code></div>
    </div>}
    {preview && !activePreview && <div className="dim mt-2">Preview cleared because the order intent changed.</div>}
    <button disabled={!validInput || previewing || Boolean(outcome)} className="term-btn w-full mt-2"
      onClick={() => void createPreview()}>{previewing ? "PREVIEWING…" : "1 · RISK PREVIEW"}</button>
    <button disabled className="term-btn w-full mt-1 !border-[#75404a] !text-[#ff9cab]"
      title={submitBlockedReason} onClick={() => void submitPaper()}>2 · PAPER SUBMIT BLOCKED</button>
    <div className="dim text-[9px] mt-2">Standard equity option multiplier: 100. The server intent and expiry above control any later confirmation.</div>
    <div className="down text-[9px] mt-1">{submitBlockedReason}</div>
  </div>;
}
