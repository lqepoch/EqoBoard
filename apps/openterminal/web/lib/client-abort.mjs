/**
 * Keep the client cancellation signal attached while authorization is pending.
 * The downstream callback is never invoked after the client has disconnected.
 *
 * @template T
 * @param {AbortSignal} requestSignal
 * @param {() => Promise<T>} authorize
 * @param {(authorization: T, controller: AbortController, cleanup: () => void) => Promise<Response>} run
 * @param {() => Response} clientClosed
 * @returns {Promise<Response>}
 */
export async function runWithClientAbort(requestSignal, authorize, run, clientClosed) {
  const controller = new AbortController();
  let resolveClientAbort;
  const clientAbort = new Promise((resolve) => {
    resolveClientAbort = resolve;
  });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    requestSignal.removeEventListener("abort", abortForClient);
  };
  const abortForClient = () => {
    if (!controller.signal.aborted) controller.abort(requestSignal.reason);
    cleanup();
    resolveClientAbort();
  };

  requestSignal.addEventListener("abort", abortForClient, { once: true });
  if (requestSignal.aborted) abortForClient();

  try {
    if (controller.signal.aborted) return clientClosed();

    const outcome = await Promise.race([
      Promise.resolve().then(authorize).then((authorization) => ({ kind: "authorized", authorization })),
      clientAbort.then(() => ({ kind: "aborted" })),
    ]);
    if (outcome.kind === "aborted" || controller.signal.aborted) return clientClosed();
    return await run(outcome.authorization, controller, cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}
