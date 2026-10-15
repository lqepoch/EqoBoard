import type { WidgetLifecycle, WidgetLifecyclePhase, WidgetLifecycleSnapshot } from "./contracts";

export interface WidgetLifecycleController extends WidgetLifecycle {
  suspend(): void;
  resume(): void;
  dispose(): void;
  isCurrent(generation: number): boolean;
}

function makeSnapshot(
  phase: WidgetLifecyclePhase,
  generation: number,
  signal: AbortSignal,
): WidgetLifecycleSnapshot {
  return Object.freeze({ phase, generation, signal });
}

/** Owns one abort signal per active generation and releases registered resources once. */
export function createWidgetLifecycleController(): WidgetLifecycleController {
  const listeners = new Set<() => void>();
  const cleanupCallbacks = new Set<() => void>();
  let phase: WidgetLifecyclePhase = "active";
  let generation = 1;
  let controller = new AbortController();

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Lifecycle observers are isolated; cleanup and other observers must still run.
      }
    }
  };

  const lifecycle: WidgetLifecycleController = {
    getSnapshot() {
      return makeSnapshot(phase, generation, controller.signal);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDispose(cleanup) {
      if (phase === "disposed") {
        try {
          cleanup();
        } catch {
          // Disposal is best-effort and remains idempotent.
        }
        return () => undefined;
      }
      cleanupCallbacks.add(cleanup);
      return () => cleanupCallbacks.delete(cleanup);
    },
    suspend() {
      if (phase !== "active") return;
      phase = "suspended";
      controller.abort();
      notify();
    },
    resume() {
      if (phase !== "suspended") return;
      generation += 1;
      controller = new AbortController();
      phase = "active";
      notify();
    },
    dispose() {
      if (phase === "disposed") return;
      phase = "disposed";
      controller.abort();
      notify();
      for (const cleanup of [...cleanupCallbacks]) {
        cleanupCallbacks.delete(cleanup);
        try {
          cleanup();
        } catch {
          // Continue releasing independent resources after one cleanup fails.
        }
      }
      listeners.clear();
    },
    isCurrent(candidateGeneration) {
      return phase === "active" && generation === candidateGeneration && !controller.signal.aborted;
    },
  };
  return lifecycle;
}

