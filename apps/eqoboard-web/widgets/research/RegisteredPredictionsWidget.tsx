"use client";

import { useState } from "react";
import type { NativeDataOperationMap } from "@/features/data/operations";
import {
  decodePublicPredictionProjection,
  parseRegisteredPredictionView,
  REGISTERED_RUN_ID,
  type RegisteredPredictionConfigV1,
  type RegisteredPredictionView,
} from "@/features/research/predictions";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import styles from "./research-widgets.module.css";

type PredictionOperationMap = Pick<NativeDataOperationMap, "research.predictions">;
type Props = WidgetProps<RegisteredPredictionConfigV1, PredictionOperationMap, WidgetNoActionMap>;

export function RegisteredPredictionsWidget({ config, host, onConfigChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<RegisteredPredictionView | null>(null);
  const allowed = host.auth.authenticated && host.auth.permissions.includes("research:private-read");

  async function load(): Promise<void> {
    const runId = config.runId.trim();
    if (!allowed || loading || !REGISTERED_RUN_ID.test(runId)) {
      setView(null);
      setMessage("Enter a valid run ID and sign in with research:private-read.");
      return;
    }
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    setLoading(true);
    setMessage(null);
    setView(null);
    try {
      const value = await host.data.read("research.predictions", { runId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const parsed = parseRegisteredPredictionView(value, runId);
      if (!parsed) {
        setMessage("The service response did not match the sanitized prediction contract.");
      } else {
        setView(parsed);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error && error.message === "request-failed"
          ? "Registered prediction service is unavailable."
          : "This identity may not read registered prediction evidence.");
      }
    } finally {
      lifecycle.signal.removeEventListener("abort", abort);
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const projection = view ? decodePublicPredictionProjection(view) : null;
  const assessment = view?.assessment;

  return (
    <section className={styles.widget} aria-label="Registered predictions" data-testid="registered-prediction-widget">
      <header className={styles.header}>
        <div><h2>Registered predictions</h2><p>Private research evidence is read-only and never promotes into an execution signal.</p></div>
      </header>
      {!allowed ? <p className={styles.empty}>This view requires the separate research:private-read permission.</p> : null}
      <div className={styles.form}>
        <label className={styles.control}>
          <span>Registered run ID</span>
          <input value={config.runId} maxLength={255} autoComplete="off" spellCheck={false}
            onChange={(event) => onConfigChange({ ...config, runId: event.currentTarget.value })}
            placeholder="Registered run ID" aria-label="Registered run ID" />
        </label>
        <button type="button" onClick={() => void load()} disabled={!allowed || loading || !REGISTERED_RUN_ID.test(config.runId.trim())}>
          {loading ? "Loading…" : "Look up"}
        </button>
      </div>
      {message ? <p className={styles.error} role="alert">{message}</p> : null}
      {!view && !message && allowed ? <p className={styles.empty}>Run lookup is explicit; no research service request has been made.</p> : null}
      {view && assessment ? (
        <div className={styles.compareResult} data-testid="prediction-evidence">
          <div className={styles.evidence}>
            <span>Run {view.run_id}</span>
            <span>Authority {view.authority}</span>
            <span>Status {view.prediction_status}</span>
            <span>Lifecycle {assessment.lifecycle}</span>
            <span>Promotion not allowed</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                <tr><th scope="row">Identity resolution</th><td>{assessment.identity_resolution}</td></tr>
                <tr><th scope="row">Source manifest binding</th><td>{assessment.source_manifest_binding}</td></tr>
                <tr><th scope="row">Finite receipt binding</th><td>{assessment.finite_receipt_binding}</td></tr>
                <tr><th scope="row">Point-in-time completeness</th><td>{assessment.point_in_time}</td></tr>
                <tr><th scope="row">Source manifest SHA-256</th><td>{view.source_manifest_sha256}</td></tr>
                <tr><th scope="row">Projection receipt SHA-256</th><td>{view.projection_receipt_sha256}</td></tr>
              </tbody>
            </table>
          </div>
          {assessment.reason_codes.length ? (
            <div><h3>Assessment reasons</h3><ul className={styles.reasonList}>{assessment.reason_codes.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
          ) : null}
          {projection ? (
            <details>
              <summary className={styles.summary}>Show BFF-validated public ProtoJSON projection</summary>
              <pre className={styles.projection}>{projection}</pre>
            </details>
          ) : <p className={styles.notice}>No public projection is available; private artifacts are not returned to the browser.</p>}
          <p className={styles.notice}>The BFF validates the public projection. Source completeness is unknown and promotion remains disabled.</p>
        </div>
      ) : null}
    </section>
  );
}
