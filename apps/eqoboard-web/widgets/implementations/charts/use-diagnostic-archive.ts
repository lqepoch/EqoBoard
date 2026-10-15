"use client";

import { useEffect, useState } from "react";
import {
  buildMdpDiagnosticChartData,
  type MdpDiagnosticChartData,
} from "../../../charts/mdp-diagnostic";
import { decodeMdpBarsResponse } from "../../../features/market/mdp-archive";
import type { NativeChartOperationMap } from "../../../charts/native-operations";
import type { WidgetHostContext } from "../../../widgets/sdk/contracts";
import type { WidgetNoActionMap } from "../../../widgets/sdk/actions";
import type { MarketHostSnapshot } from "../../../stores/market/market-store";
import type { ChartSurfaceStatus } from "../../../charts/ChartSurface";
import { isDiagnosticDatasetId } from "./config";

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const PROJECTION_ERROR =
  "One or more validated archive rows exceeded the finite chart projection bounds; no partial archive was plotted.";

type DiagnosticState = Readonly<{
  key: string;
  status: ChartSurfaceStatus;
  data: MdpDiagnosticChartData | null;
  error: string | null;
}>;

export type DiagnosticArchiveView = Readonly<{
  status: ChartSurfaceStatus;
  data: MdpDiagnosticChartData | null;
  error: string | null;
}>;

type ChartHost = WidgetHostContext<NativeChartOperationMap, WidgetNoActionMap, MarketHostSnapshot>;

function requestKey(symbol: string, datasetId: string): string {
  return `${symbol}\u0000${datasetId}`;
}

/** Performs one lifecycle-bound read of the fixed, noncanonical MDP archive operation. */
export function useDiagnosticArchive(
  enabled: boolean,
  symbol: string,
  datasetId: string | null,
  retryRevision: number,
  host: ChartHost,
): DiagnosticArchiveView {
  const validInput = SYMBOL.test(symbol) && isDiagnosticDatasetId(datasetId);
  const key = validInput ? requestKey(symbol, datasetId) : "";
  const [state, setState] = useState<DiagnosticState | null>(null);
  const [lifecycleRevision, setLifecycleRevision] = useState(0);

  useEffect(
    () =>
      host.lifecycle.subscribe(() => {
        setLifecycleRevision((revision) => revision + 1);
      }),
    [host.lifecycle],
  );

  useEffect(() => {
    if (!enabled || !validInput) return undefined;

    const lifecycleSnapshot = host.lifecycle.getSnapshot();
    if (lifecycleSnapshot.phase !== "active") return undefined;
    const controller = new AbortController();
    const lifecycleSignal = lifecycleSnapshot.signal;
    const abortForLifecycle = () => controller.abort();
    if (lifecycleSignal.aborted) controller.abort();
    else lifecycleSignal.addEventListener("abort", abortForLifecycle, { once: true });

    let active = true;
    const failRead = (message: string) => {
      setState((current) => {
        const retained = current?.key === key ? current.data : null;
        return {
          key,
          status: retained ? "ready" : "error",
          data: retained,
          error: retained ? `${message} Last validated archive rows remain visible.` : message,
        };
      });
    };
    void host.data
      .read(
        "market.archive.diagnostic-bars",
        { datasetId: datasetId!, symbol },
        { signal: controller.signal },
      )
      .then((raw) => {
        if (!active || controller.signal.aborted) return;
        const response = decodeMdpBarsResponse(raw, { datasetId: datasetId!, symbol });
        if (!response) {
          failRead(
            "The diagnostic archive response did not match the requested dataset, symbol, or MDP Bars V1 contract.",
          );
          return;
        }
        const data = buildMdpDiagnosticChartData(response);
        setState({
          key,
          status: data.projection.rejectedRows > 0 ? "error" : "ready",
          data,
          error: data.projection.rejectedRows > 0 ? PROJECTION_ERROR : null,
        });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        failRead(
          "The diagnostic archive could not be loaded. It is a bounded diagnostic read, not a live feed.",
        );
      });

    return () => {
      active = false;
      lifecycleSignal.removeEventListener("abort", abortForLifecycle);
      controller.abort();
    };
  }, [
    datasetId,
    enabled,
    host.data,
    host.lifecycle,
    key,
    lifecycleRevision,
    retryRevision,
    symbol,
    validInput,
  ]);

  if (!enabled) return { status: "idle", data: null, error: null };
  if (!SYMBOL.test(symbol)) {
    return {
      status: "error",
      data: null,
      error: "Select a valid active or fixed symbol before loading a diagnostic archive.",
    };
  }
  if (!isDiagnosticDatasetId(datasetId)) {
    return { status: "idle", data: null, error: null };
  }
  if (state?.key !== key) return { status: "loading", data: null, error: null };

  return {
    status: state.status,
    data: state.data,
    error: state.error,
  };
}
