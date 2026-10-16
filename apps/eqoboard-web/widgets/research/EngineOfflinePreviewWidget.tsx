"use client";

import type {
  EngineStatusResponseV1,
  SyntheticOfflinePreviewV1,
} from "@lqepoch/trading-core-contracts";
import { useEffect, useRef, useState } from "react";
import type { NativeDataOperationMap } from "@/features/data/operations";
import { parseEngineStatus, parseSyntheticOfflinePreview } from "@/features/research/engine";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import styles from "./research-widgets.module.css";

type EngineReadOperationMap = Pick<NativeDataOperationMap, "engine.status" | "engine.preview">;
export type EngineOfflinePreviewConfigV1 = Readonly<{ schemaVersion: 1 }>;
type Props = WidgetProps<EngineOfflinePreviewConfigV1, EngineReadOperationMap, WidgetNoActionMap>;

export function EngineOfflinePreviewWidget({ host }: Props) {
  const [status, setStatus] = useState<EngineStatusResponseV1 | null>(null);
  const [preview, setPreview] = useState<SyntheticOfflinePreviewV1 | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const allowed = host.auth.authenticated && host.auth.permissions.includes("engine:offline-read");

  useEffect(() => () => activeRequest.current?.abort(), []);

  async function refresh(): Promise<void> {
    if (!allowed || loading) return;
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setLoading(true);
    setStatusError(null);
    setPreviewError(null);
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      outcomes = await Promise.allSettled([
        host.data.read("engine.status", {}, { signal: controller.signal }),
        host.data.read("engine.preview", {}, { signal: controller.signal }),
      ]);
    } finally {
      lifecycle.signal.removeEventListener("abort", abort);
      if (activeRequest.current === controller) activeRequest.current = null;
      setLoading(false);
    }
    if (controller.signal.aborted) return;

    const parsedStatus =
      outcomes[0]?.status === "fulfilled" ? parseEngineStatus(outcomes[0].value) : null;
    const parsedPreview =
      outcomes[1]?.status === "fulfilled" ? parseSyntheticOfflinePreview(outcomes[1].value) : null;
    setStatus(parsedStatus);
    setPreview(parsedPreview);
    setStatusError(
      parsedStatus
        ? null
        : "Status is unavailable or did not match the Core-generated response contract.",
    );
    setPreviewError(
      parsedPreview
        ? null
        : "Preview is unavailable or did not match the Core-generated response contract.",
    );
  }

  return (
    <section
      className={styles.widget}
      aria-label="Engine offline preview"
      data-testid="engine-offline-preview-widget"
    >
      <header className={styles.header}>
        <div>
          <h2>Offline state preview</h2>
          <p>
            Synthetic diagnostic only. Source is unknown; account and market data are not loaded.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={!allowed || loading}>
          {loading ? "Loading…" : status || preview ? "Refresh" : "Load preview"}
        </button>
      </header>
      {!allowed ? (
        <p className={styles.empty}>
          This view requires the separate engine:offline-read permission.
        </p>
      ) : null}
      {allowed && !status && !preview && !statusError && !previewError ? (
        <p className={styles.empty}>Offline preview has not been queried.</p>
      ) : null}
      {statusError ? (
        <p className={styles.error} role="alert">
          {statusError}
        </p>
      ) : null}
      {previewError ? (
        <p className={styles.error} role="alert">
          {previewError}
        </p>
      ) : null}
      {status || preview ? (
        <div className={styles.compareResult} data-testid="engine-preview-evidence">
          <div className={styles.evidence}>
            <span>Source: unknown</span>
            <span>Mode: {preview?.sourceMode ?? status?.mode ?? "unknown"}</span>
            <span>Provenance: {preview?.sourceProvenance ?? "unknown"}</span>
            <span>Service readiness: {status?.serviceReadiness ?? "unknown"}</span>
            <span>Source readiness: {status?.sourceReadiness ?? "unknown"}</span>
            <span>Execution: disabled</span>
            <span>Order mutations: disabled</span>
            <span>Account data loaded: no</span>
            <span>Market data connected: no</span>
          </div>
          {status || preview ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <tbody>
                  <tr>
                    <th scope="row">Pending unknown records</th>
                    <td>
                      {preview?.pendingUnknownCount ?? status?.pendingUnknownCount ?? "unavailable"}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Sample capped</th>
                    <td>
                      {preview?.pendingUnknownCountCapped ??
                        status?.pendingUnknownCountCapped ??
                        "unknown"}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Consumed risk reservations</th>
                    <td>
                      {preview?.pendingUnknownConsumedRiskCount ??
                        status?.pendingUnknownConsumedRiskCount ??
                        "unavailable"}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Unverified risk reservations</th>
                    <td>
                      {preview?.pendingUnknownUnverifiedRiskCount ??
                        status?.pendingUnknownUnverifiedRiskCount ??
                        "unavailable"}
                    </td>
                  </tr>
                  {preview ? (
                    <tr>
                      <th scope="row">Disposition</th>
                      <td>{preview.disposition}</td>
                    </tr>
                  ) : null}
                  {status ? (
                    <tr>
                      <th scope="row">Core schema version</th>
                      <td>{status.schemaVersion}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className={styles.notice}>
            Status and preview are independent best-effort reads, not a transactional snapshot or
            reconciliation proof. They do not grant trading, account, market-data, or promotion
            authority.
          </p>
        </div>
      ) : null}
    </section>
  );
}
