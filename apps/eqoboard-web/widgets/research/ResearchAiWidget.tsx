"use client";

import { useState } from "react";

import { parseResearchAiResponse } from "@/features/research/ai";
import type { NativeActionMap } from "@/features/data/operations";
import type { WidgetOperationMap } from "@/widgets/sdk/data";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import styles from "./research-widgets.module.css";

export type ResearchAiConfigV1 = Readonly<{ schemaVersion: 1 }>;

type ResearchAiActionMap = Pick<NativeActionMap, "research.ai">;

export function ResearchAiWidget({ host }: WidgetProps<ResearchAiConfigV1, WidgetOperationMap, ResearchAiActionMap>) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState<Readonly<{ text: string; generatedAt: string; provider: string }> | null>(null);
  const allowed = host.auth.authenticated && host.auth.permissions.includes("research:ai");

  async function ask(): Promise<void> {
    const text = prompt.trim();
    if (!allowed || busy || text.length === 0 || text.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return;
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    setBusy(true);
    setMessage("");
    try {
      const result = await host.actions.invoke("research.ai", {
        messages: [{ role: "user", content: text }],
      }, { signal: controller.signal });
      const parsed = parseResearchAiResponse(result);
      if (!parsed) {
        setMessage("The AI service returned an invalid response.");
        return;
      }
      setAnswer(parsed);
      setPrompt("");
    } catch {
      if (!controller.signal.aborted) setMessage("AI research is unavailable for this request.");
    } finally {
      lifecycle.signal.removeEventListener("abort", abort);
      setBusy(false);
    }
  }

  return (
    <section className={styles.widget} aria-label="AI research assistant">
      <header className={styles.header}>
        <div><h2>AI research assistant</h2><p>Generated analysis is not a provider observation or an investment instruction.</p></div>
      </header>
      {!allowed ? <p className={styles.empty}>This view requires the research:ai permission.</p> : null}
      <label className={styles.control}>
        <span>Prompt</span>
        <textarea
          value={prompt}
          maxLength={4_000}
          rows={5}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          placeholder="Ask about research you provide in the prompt."
          disabled={!allowed || busy}
        />
      </label>
      <div className={styles.form}>
        <button type="button" onClick={() => void ask()} disabled={!allowed || busy || prompt.trim().length === 0}>
          {busy ? "Generating…" : "Ask"}
        </button>
        <span className={styles.notice}>The service does not receive market, account, or order data from this widget.</span>
      </div>
      {message ? <p className={styles.error} role="alert">{message}</p> : null}
      {answer ? (
        <article className={styles.compareResult} aria-label="AI-generated response">
          <p className={styles.notice}>AI-generated · {answer.provider} · {answer.generatedAt}</p>
          <p className={styles.aiText}>{answer.text}</p>
        </article>
      ) : null}
    </section>
  );
}
