"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { WORKSPACE_LIMITS, type WorkspaceDocumentV1 } from "../../workspace/model";
import {
  createWorkspaceExport,
  parseWorkspaceExportJson,
  parseWorkspaceJson,
} from "../../workspace/schema";

type WorkspaceTransferControlsProps = Readonly<{
  document: WorkspaceDocumentV1;
  canEdit: boolean;
  onImport(document: WorkspaceDocumentV1, mode: "copy" | "replace"): Promise<boolean>;
}>;

export function WorkspaceTransferControls({
  document,
  canEdit,
  onImport,
}: WorkspaceTransferControlsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<WorkspaceDocumentV1 | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function exportDocument(): void {
    setMessage(null);
    try {
      const text = JSON.stringify(createWorkspaceExport(document), null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = "eqoboard-workspaces.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage("Workspace export downloaded. It contains layout and widget configuration only.");
    } catch {
      setMessage("Workspace export could not be created.");
    }
  }

  async function inspectFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    setErrors([]);
    setMessage(null);
    setPreview(null);
    setReplaceOpen(false);
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > WORKSPACE_LIMITS.maxDocumentBytes + 1024) {
      setErrors(["The selected file exceeds the 65 KiB export limit."]);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setErrors(["The selected workspace file could not be read."]);
      return;
    }
    const exported = parseWorkspaceExportJson(text);
    if (exported.ok) {
      setPreview(exported.value.document);
      return;
    }
    const parsed = parseWorkspaceJson(text);
    if (!parsed.ok) {
      const details =
        exported.errors.length <= parsed.errors.length ? exported.errors : parsed.errors;
      setErrors(details.slice(0, 8).map((error) => `${error.path}: ${error.message}`));
      return;
    }
    setPreview(parsed.value);
  }

  async function importAsCopy(): Promise<void> {
    if (!canEdit || !preview || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const success = await onImport(preview, "copy");
      setMessage(
        success
          ? "Import applied with fresh IDs. Check workspace sync status for server confirmation."
          : "Import was not applied. Check the workspace sync status and limits.",
      );
      if (success) setPreview(null);
    } catch {
      setMessage("Import was not saved. Check the workspace sync status and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function replaceCurrent(): Promise<void> {
    if (!canEdit || !preview || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const success = await onImport(preview, "replace");
      setReplaceOpen(false);
      setMessage(
        success
          ? "Replacement applied. Check workspace sync status for server confirmation; the previous version is available in local recovery copies."
          : "Replacement was not saved. The previous workspace remains active.",
      );
      if (success) setPreview(null);
    } catch {
      setMessage("Replacement was not saved. The previous workspace remains active.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="workspace-transfer">
      <summary>Import or export</summary>
      <div className="workspace-transfer-actions">
        <button data-testid="workspace-export" onClick={exportDocument} type="button">
          Export JSON
        </button>
        <label className="workspace-file-button">
          <span>Choose workspace file</span>
          <input
            accept="application/json,.json"
            aria-label="Choose workspace JSON file"
            onChange={(event) => void inspectFile(event)}
            ref={fileInput}
            type="file"
          />
        </label>
      </div>
      <p className="workspace-muted">
        Imports are validated before they are shown. Copy creates fresh workspace, tab, template and
        widget IDs.
      </p>
      {errors.length > 0 && (
        <ul className="workspace-import-errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {preview && (
        <div className="workspace-import-preview" data-testid="workspace-import-preview">
          <p>
            Preview: {preview.workspaces.length} workspaces,{" "}
            {preview.workspaces.reduce((sum, workspace) => sum + workspace.tabs.length, 0)} tabs,{" "}
            {preview.workspaces.reduce(
              (sum, workspace) =>
                sum + workspace.tabs.reduce((tabSum, tab) => tabSum + tab.widgets.length, 0),
              0,
            )}{" "}
            widgets.
          </p>
          <div className="workspace-transfer-actions">
            <button
              data-testid="workspace-import-confirm-copy"
              disabled={!canEdit || busy}
              onClick={() => void importAsCopy()}
              type="button"
            >
              Import as copies
            </button>
            <button
              data-testid="workspace-import-replace"
              disabled={!canEdit || busy}
              onClick={() => setReplaceOpen(true)}
              type="button"
            >
              Review replacement
            </button>
          </div>
          {replaceOpen && (
            <div
              aria-labelledby="workspace-replace-title"
              aria-modal="true"
              className="workspace-confirm"
              role="dialog"
            >
              <h3 id="workspace-replace-title">Replace this account’s workspace?</h3>
              <p>
                The current workspace will be backed up in this browser before the imported document
                replaces it.
              </p>
              <div className="workspace-transfer-actions">
                <button disabled={busy} onClick={() => setReplaceOpen(false)} type="button">
                  Cancel
                </button>
                <button disabled={busy} onClick={() => void replaceCurrent()} type="button">
                  Confirm replacement
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {message && (
        <p aria-live="polite" className="workspace-status-message">
          {message}
        </p>
      )}
    </details>
  );
}
