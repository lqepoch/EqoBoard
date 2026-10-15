"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { ResourceState } from "@/components/shell/ResourceState";
import type { NativeActionMap, VerticalPreviewIntent } from "@/features/data/operations";
import { decodeVerticalPreviewReceipt } from "@/features/market/market-contracts";
import type { VerticalPreviewReceipt } from "@/features/market/market-contracts";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetOperationMap } from "@/widgets/sdk/data";
import type { EmptyMarketConfigV1 } from "./config";
import styles from "./market-widgets.module.css";

export type VerticalPreviewWidgetProps = WidgetProps<
  EmptyMarketConfigV1,
  WidgetOperationMap,
  Pick<NativeActionMap, "orders.preview.vertical">,
  MarketHostSnapshot
>;

type PreviewState =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{ status: "error"; detail: string }>
  | Readonly<{ status: "ready"; value: VerticalPreviewReceipt }>;

const OCC = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/u;

function validVerticalIntent(
  buySymbol: string,
  sellSymbol: string,
  quantity: number,
  limitPriceInput: string,
  netEffect: "debit" | "credit",
): VerticalPreviewIntent | null {
  const buy = OCC.exec(buySymbol);
  const sell = OCC.exec(sellSymbol);
  if (
    !buy ||
    !sell ||
    buySymbol === sellSymbol ||
    buy[1] !== sell[1] ||
    buy[2] !== sell[2] ||
    buy[3] !== sell[3] ||
    buy[4] === sell[4]
  )
    return null;
  const limitPrice = Number(limitPriceInput);
  if (
    !/^\d+(?:\.\d{1,2})?$/u.test(limitPriceInput) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 0xffff_ffff ||
    !Number.isFinite(limitPrice) ||
    limitPrice <= 0 ||
    !Number.isSafeInteger(limitPrice * 100) ||
    (limitPrice * 100) / 100 !== limitPrice
  )
    return null;
  const expiry = new Date(
    Date.UTC(
      2000 + Number(buy[2]!.slice(0, 2)),
      Number(buy[2]!.slice(2, 4)) - 1,
      Number(buy[2]!.slice(4, 6)),
    ),
  );
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiry.toISOString().slice(2, 10).replaceAll("-", "") !== buy[2] ||
    expiry.getTime() <= Date.now()
  )
    return null;
  const buyStrike = BigInt(buy[4]!);
  const sellStrike = BigInt(sell[4]!);
  const width = buyStrike > sellStrike ? buyStrike - sellStrike : sellStrike - buyStrike;
  if (BigInt(Math.round(limitPrice * 100)) * 10n >= width) return null;
  const expectedEffect =
    buy[3] === "C"
      ? buyStrike < sellStrike
        ? "debit"
        : "credit"
      : buyStrike > sellStrike
        ? "debit"
        : "credit";
  if (netEffect !== expectedEffect) return null;
  return Object.freeze({
    broker: "alpaca",
    environment: "paper",
    kind: "vertical",
    symbol: null,
    quantity,
    limit_price: limitPrice,
    net_effect: netEffect,
    legs: Object.freeze([
      Object.freeze({ symbol: buySymbol, side: "buy" as const }),
      Object.freeze({ symbol: sellSymbol, side: "sell" as const }),
    ]) as VerticalPreviewIntent["legs"],
  });
}

function currency(value: number, code: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
}

export function VerticalPreviewWidget({ host }: VerticalPreviewWidgetProps) {
  const [buySymbol, setBuySymbol] = useState("");
  const [sellSymbol, setSellSymbol] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [netEffect, setNetEffect] = useState<"debit" | "credit">("debit");
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const activeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const invalidatePreview = () => {
    requestSequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setState({ status: "idle" });
  };

  const submitPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    invalidatePreview();
    const intent = validVerticalIntent(
      buySymbol.trim(),
      sellSymbol.trim(),
      Number(quantity),
      limitPrice,
      netEffect,
    );
    if (!intent) {
      setState({
        status: "error",
        detail:
          "Enter a matching standard OCC vertical, a valid quantity, a whole-cent limit below the spread width, and its matching debit or credit effect.",
      });
      return;
    }
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) {
      setState({
        status: "error",
        detail: "The preview is unavailable while this widget is inactive.",
      });
      return;
    }
    const controller = new AbortController();
    const sequence = requestSequence.current;
    const abortForLifecycle = () => {
      controller.abort();
      if (requestSequence.current === sequence) setState({ status: "idle" });
    };
    lifecycle.signal.addEventListener("abort", abortForLifecycle, { once: true });
    activeRequest.current = controller;
    setState({ status: "loading" });
    void host.actions
      .invoke("orders.preview.vertical", intent, { signal: controller.signal })
      .then((raw) => {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        const receipt = decodeVerticalPreviewReceipt(raw, intent);
        setState(
          receipt
            ? { status: "ready", value: receipt }
            : {
                status: "error",
                detail:
                  "The Gateway response did not match the disabled-execution preview contract.",
              },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted && requestSequence.current === sequence) {
          setState({
            status: "error",
            detail:
              "The same-origin order preview failed or was not authorized. No order was submitted.",
          });
        }
      })
      .finally(() => {
        lifecycle.signal.removeEventListener("abort", abortForLifecycle);
        if (activeRequest.current === controller) activeRequest.current = null;
      });
  };

  return (
    <section
      className={styles.marketWidget}
      data-testid="market-vertical-preview-widget"
      aria-label="Vertical order preview"
    >
      <h2>Vertical preview</h2>
      <ResourceState
        state={
          state.status === "ready"
            ? "ready"
            : state.status === "loading"
              ? "loading"
              : state.status === "error"
                ? "error"
                : "unknown"
        }
        title="Paper order preview"
        detail={
          state.status === "error"
            ? state.detail
            : state.status === "loading"
              ? "Requesting a server-side risk preview."
              : "This control requests a preview only; execution is disabled."
        }
        metadata="Broker Alpaca · paper environment · no submit action exists"
      />
      <form className={styles.previewForm} onSubmit={submitPreview}>
        <label className={styles.controlLabel}>
          Buy contract (OCC)
          <input
            autoComplete="off"
            maxLength={21}
            onChange={(event) => {
              invalidatePreview();
              setBuySymbol(event.target.value.toUpperCase());
            }}
            value={buySymbol}
          />
        </label>
        <label className={styles.controlLabel}>
          Sell contract (OCC)
          <input
            autoComplete="off"
            maxLength={21}
            onChange={(event) => {
              invalidatePreview();
              setSellSymbol(event.target.value.toUpperCase());
            }}
            value={sellSymbol}
          />
        </label>
        <label className={styles.controlLabel}>
          Quantity
          <input
            min="1"
            max="4294967295"
            step="1"
            type="number"
            value={quantity}
            onChange={(event) => {
              invalidatePreview();
              setQuantity(event.target.value);
            }}
          />
        </label>
        <label className={styles.controlLabel}>
          Limit price
          <input
            min="0.01"
            step="0.01"
            type="number"
            value={limitPrice}
            onChange={(event) => {
              invalidatePreview();
              setLimitPrice(event.target.value);
            }}
          />
        </label>
        <label className={styles.controlLabel}>
          Net effect
          <select
            value={netEffect}
            onChange={(event) => {
              invalidatePreview();
              setNetEffect(event.target.value as "debit" | "credit");
            }}
          >
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
        </label>
        <button
          className={styles.previewButton}
          disabled={state.status === "loading"}
          type="submit"
        >
          Request preview
        </button>
      </form>
      {state.status === "ready" ? (
        <dl className={styles.previewReceipt}>
          <div>
            <dt>Estimated max loss</dt>
            <dd>{currency(state.value.preview.estimatedMaxLoss, state.value.preview.currency)}</dd>
          </div>
          <div>
            <dt>Preview expires</dt>
            <dd>{state.value.preview.expiresAt}</dd>
          </div>
          <div>
            <dt>Preview ID</dt>
            <dd>
              <code>{state.value.preview.previewId}</code>
            </dd>
          </div>
          <div>
            <dt>Execution</dt>
            <dd>disabled</dd>
          </div>
        </dl>
      ) : null}
      <p className={styles.marketFootnote}>
        The server revalidates the exact two-leg intent and current permissions. This widget never
        sends an order.
      </p>
    </section>
  );
}
