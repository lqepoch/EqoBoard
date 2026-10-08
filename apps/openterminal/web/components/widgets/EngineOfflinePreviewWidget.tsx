"use client";

import type {
  EngineStatusResponseV1,
  SyntheticOfflinePreviewV1,
} from "@lqepoch/trading-core-contracts";
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_RESPONSE_BYTES = 16 * 1024;

async function readBoundedProjection<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("engine_invalid_response");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("engine_invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("engine_invalid_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("engine_invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new Error("engine_invalid_response");
  }
}

async function readProjection<T>(
  path: "/api/eqo/engine/status" | "/api/eqo/engine/preview",
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 403 ? "engine_forbidden" : "engine_unavailable");
  }
  // The same-origin BFF validated and projected the payload into Core's generated
  // Message shape. The browser uses generated types only, not a second parser.
  return readBoundedProjection<T>(response);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "engine_forbidden") {
    return "Your organization role does not allow this offline preview.";
  }
  if (error instanceof Error && error.message === "engine_invalid_response") {
    return "The Engine returned an invalid preview contract.";
  }
  return "Offline preview is unavailable or not configured.";
}

export default function EngineOfflinePreviewWidget() {
  const [status, setStatus] = useState<EngineStatusResponseV1 | null>(null);
  const [preview, setPreview] = useState<SyntheticOfflinePreviewV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    setStatus(null);
    setPreview(null);
    try {
      const nextStatus = await readProjection<EngineStatusResponseV1>(
        "/api/eqo/engine/status",
        signal,
      );
      const nextPreview = await readProjection<SyntheticOfflinePreviewV1>(
        "/api/eqo/engine/preview",
        signal,
      );
      if (!signal.aborted) {
        setStatus(nextStatus);
        setPreview(nextPreview);
      }
    } catch (cause) {
      if (!signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  const startRefresh = useCallback(() => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    void refresh(controller.signal);
  }, [refresh]);

  useEffect(() => {
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [startRefresh]);

  return (
    <section className="flex h-full min-h-0 flex-col gap-2 p-2 text-[11px]" data-testid="engine-offline-preview-widget">
      <div className="flex items-center justify-between gap-2">
        <strong>OFFLINE STATE PREVIEW</strong>
        <button type="button" className="term-btn" onClick={startRefresh} disabled={loading}>
          {loading ? "LOADING" : status ? "REFRESH" : "LOAD PREVIEW"}
        </button>
      </div>
      <p className="dim">
        Synthetic diagnostic only. Source is unknown; account and market data are not loaded.
        Execution, orders, and mutations remain disabled.
      </p>
      {error && <p role="alert" className="down">{error}</p>}
      {!status && !error && <p className="dim">Engine preview has not been queried.</p>}
      {status && preview && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto" data-testid="engine-preview-evidence">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <span>Mode: <strong>{preview.sourceMode}</strong></span>
            <span>Provenance: <strong>{preview.sourceProvenance}</strong></span>
            <span>Service: {status.serviceReadiness}</span>
            <span>Source readiness: {status.sourceReadiness}</span>
            <span>Execution: <strong>DISABLED</strong></span>
            <span>Order mutations: <strong>DISABLED</strong></span>
            <span>Account data loaded: no</span>
            <span>Market data connected: no</span>
          </div>
          <div className="border-t border-[var(--border)] pt-2">
            <div>Pending unknown records in bounded sample: {preview.pendingUnknownCount}</div>
            {preview.pendingUnknownCountCapped && <div className="dim">The sample reached its cap; the total may be larger.</div>}
            <div>Consumed risk reservations: {preview.pendingUnknownConsumedRiskCount}</div>
            <div>Unverified risk reservations: {preview.pendingUnknownUnverifiedRiskCount}</div>
            <div>Disposition: {preview.disposition}</div>
          </div>
          <p className="dim">
            Status and preview are separate best-effort reads, not a transactional snapshot or reconciliation proof.
            They do not grant trading, account, market-data, or promotion authority.
          </p>
        </div>
      )}
    </section>
  );
}
