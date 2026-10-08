"use client";

import { useState, type FormEvent } from "react";
import type { RegisteredPredictionView } from "../../lib/quant-prediction-contract";
import type { WidgetInstance } from "../../store/terminal";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/;

function isPredictionView(value: unknown): value is RegisteredPredictionView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.schema_name === "quant-research-registered-prediction-v1" &&
    result.authority === "LOCAL_REGISTERED_ROOT" && result.read_only === true &&
    result.promotion_allowed === false && typeof result.run_id === "string" &&
    typeof result.prediction_status === "string" && typeof result.assessment === "object" &&
    result.assessment !== null && !Array.isArray(result.assessment) &&
    (!Object.hasOwn(result, "private_artifact_sha256") && !Object.hasOwn(result, "private_envelope"));
}

function decodeValidatedPublicProjection(view: RegisteredPredictionView): string | null {
  if (!view.public_protojson_base64) return null;
  try {
    const raw = atob(view.public_protojson_base64);
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    // The same-origin BFF already validated these bytes with the pinned Core ProtoJSON parser.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export default function ResearchPredictionsWidget({ widget }: { widget: WidgetInstance }) {
  const [draftRunId, setDraftRunId] = useState("");
  const [requestedRunId, setRequestedRunId] = useState<string | null>(null);
  const [view, setView] = useState<RegisteredPredictionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadPrediction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const runId = draftRunId.trim();
    if (!RUN_ID.test(runId)) {
      setError("Enter a valid registered run ID.");
      setView(null);
      return;
    }
    setLoading(true);
    setError(null);
    setView(null);
    setRequestedRunId(runId);
    try {
      const response = await fetch(`/api/eqo/research/predictions/${encodeURIComponent(runId)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(response.status === 404 ? "Registered run not found." :
          response.status === 403 ? "This identity is not authorized for private research reads." :
          "Research service is not configured or unavailable.");
      } else if (!isPredictionView(body) || body.run_id !== runId) {
        setError("The research service returned an invalid prediction view.");
      } else {
        setView(body);
      }
    } catch {
      setError("Research service is not configured or unavailable.");
    } finally {
      setLoading(false);
    }
  }

  const projection = view ? decodeValidatedPublicProjection(view) : null;
  const assessment = view?.assessment;

  return (
    <section className="flex h-full min-h-0 flex-col gap-2 p-2 text-[11px]" data-testid="registered-prediction-widget">
      <p className="dim">Read-only registered prediction evidence. The private artifact and envelope are never requested or displayed.</p>
      <form className="flex gap-2" onSubmit={loadPrediction}>
        <label className="sr-only" htmlFor={`registered-run-id-${widget.id}`}>Registered run ID</label>
        <input
          id={`registered-run-id-${widget.id}`}
          value={draftRunId}
          onChange={(event) => setDraftRunId(event.target.value)}
          maxLength={255}
          autoComplete="off"
          spellCheck={false}
          placeholder="Registered run ID"
          className="min-w-0 flex-1 bg-[#111] border border-[var(--border)] px-2 py-1 text-[var(--text)]"
          data-testid="registered-run-id"
        />
        <button type="submit" className="term-btn" disabled={loading}>
          {loading ? "LOADING" : "LOOK UP"}
        </button>
      </form>
      {error && <p role="alert" className="down">{error}</p>}
      {!view && !error && <p className="dim">Registered prediction service: not queried.</p>}
      {view && assessment && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto" data-testid="prediction-evidence">
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-[var(--border)] pb-2">
            <span>Run <strong>{view.run_id}</strong></span>
            <span>Authority <strong>{view.authority}</strong></span>
            <span>Status <strong>{view.prediction_status}</strong></span>
            <span>Lifecycle <strong>{assessment.lifecycle}</strong></span>
            <span>Promotion <strong className="down">NOT ALLOWED</strong></span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
            <span>Identity resolution: {assessment.identity_resolution}</span>
            <span>Source manifest: {assessment.source_manifest_binding}</span>
            <span>Finite receipt: {assessment.finite_receipt_binding}</span>
            <span>Point in time: {assessment.point_in_time}</span>
          </div>
          <p className="dim">Read-only local registry observation. Source completeness and promotion remain unverified.</p>
          {assessment.reason_codes.length > 0 && (
            <div>
              <div className="dim mb-1">Assessment reasons</div>
              <ul className="list-disc pl-5">
                {assessment.reason_codes.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          )}
          {projection ? (
            <details className="min-h-0">
              <summary className="cursor-pointer text-[var(--amber)]">Show public ProtoJSON projection</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--border)] bg-[#090909] p-2 text-[10px]">
                {projection}
              </pre>
            </details>
          ) : <p className="dim">No public ProtoJSON projection is available for this run.</p>}
          {requestedRunId && <span className="sr-only">Loaded {requestedRunId}</span>}
        </div>
      )}
    </section>
  );
}
