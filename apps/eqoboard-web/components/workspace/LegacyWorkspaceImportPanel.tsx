"use client";

import { useState } from "react";
import type { WidgetRegistry } from "../../widgets/registry/types";
import type { WorkspaceDocumentV1 } from "../../workspace/model";
import {
  LEGACY_WORKSPACE_STORAGE_KEY,
  previewLegacyWorkspaceImport,
  type LegacyWorkspaceImportPreview,
} from "../../workspace/legacy-import";

type LegacyWorkspaceImportPanelProps = Readonly<{
  registry: WidgetRegistry;
  canImport: boolean;
  disabledLabel?: string;
  onImport?(document: WorkspaceDocumentV1): Promise<boolean>;
}>;

/** The legacy localStorage record is read only after an explicit preview action. */
export function LegacyWorkspaceImportPanel({
  registry,
  canImport,
  disabledLabel = "Sign in to import",
  onImport,
}: LegacyWorkspaceImportPanelProps) {
  const [preview, setPreview] = useState<LegacyWorkspaceImportPreview | null>(null);
  const [sourceSnapshot, setSourceSnapshot] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [importing, setImporting] = useState(false);

  function inspectLegacyLayout(): void {
    setMessage(null);
    setErrors([]);
    setPreview(null);
    setSourceSnapshot(null);
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY);
    } catch {
      setErrors(["Browser storage is unavailable. The legacy layout was not changed."]);
      return;
    }
    if (raw === null) {
      setErrors(["No saved OpenTerminal layout was found in this browser."]);
      return;
    }
    const result = previewLegacyWorkspaceImport(raw, registry);
    if (!result.ok) {
      setErrors(result.errors.map((entry) => `${entry.path}: ${entry.message}`));
      return;
    }
    setPreview(result.value);
    setSourceSnapshot(raw);
  }

  async function commitImport(): Promise<void> {
    if (!canImport || !onImport || !preview || sourceSnapshot === null || importing) return;
    let current: string | null;
    try {
      current = window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY);
    } catch {
      setMessage("Browser storage is unavailable. Preview again before importing.");
      return;
    }
    if (current !== sourceSnapshot) {
      setPreview(null);
      setSourceSnapshot(null);
      setMessage(
        "The saved legacy layout changed after preview. Preview the current layout before importing.",
      );
      return;
    }
    setImporting(true);
    setMessage(null);
    try {
      const imported = await onImport(preview.document);
      setMessage(
        imported
          ? "Import staged as a new workspace with fresh IDs. Check workspace sync status for server confirmation; the original legacy layout remains in this browser."
          : "Import was not saved. Resolve the workspace save status and try again.",
      );
      if (imported) {
        setPreview(null);
        setSourceSnapshot(null);
      }
    } catch {
      setMessage("Import could not be saved. The original legacy layout remains unchanged.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <section aria-labelledby="legacy-workspace-import-title" className="workspace-legacy-import">
      <div className="workspace-section-heading">
        <div>
          <p className="workspace-eyebrow">Local migration</p>
          <h2 id="legacy-workspace-import-title">Review an older layout</h2>
        </div>
        <button
          data-testid="workspace-legacy-import-preview"
          onClick={inspectLegacyLayout}
          type="button"
        >
          Preview saved layout
        </button>
      </div>
      <p className="workspace-muted">
        This reads <code>{LEGACY_WORKSPACE_STORAGE_KEY}</code> only after you ask. Preview never
        assigns it to an account or changes the saved record.
      </p>
      {errors.length > 0 && (
        <ul className="workspace-import-errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {preview && (
        <div
          className="workspace-import-preview"
          data-testid="workspace-legacy-import-preview-result"
        >
          <p>
            <strong>{preview.widgetCount} widgets</strong> in one workspace. Unsupported legacy
            types retained as inert tiles:{" "}
            {preview.retainedAsInert.length > 0 ? preview.retainedAsInert.join(", ") : "none"}.
          </p>
          {preview.warnings.length > 0 && (
            <ul className="workspace-import-warnings">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <button
            data-testid="workspace-legacy-import-confirm"
            disabled={!canImport || importing}
            onClick={() => void commitImport()}
            type="button"
          >
            {importing ? "Importing…" : canImport ? "Import as a new workspace" : disabledLabel}
          </button>
        </div>
      )}
      {message && (
        <p aria-live="polite" className="workspace-status-message">
          {message}
        </p>
      )}
    </section>
  );
}
