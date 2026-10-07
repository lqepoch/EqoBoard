import { NextRequest, NextResponse } from "next/server";
import { authorizeBffRequest } from "@/lib/eqo-auth";
import { runWithClientAbort } from "@/lib/client-abort.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The browser receives a user-authorized stream; only the BFF signs Gateway credentials. */
export async function GET(req: NextRequest) {
  const base = (process.env.EQO_RUST_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  return runWithClientAbort(
    req.signal,
    () => authorizeBffRequest(req, "market:stream", "eqoboard-gateway"),
    async (auth, upstreamAbort, removeClientAbortListener) => {
      if (!auth.ok) {
        removeClientAbortListener();
        return auth.response;
      }

      let connectDeadline: ReturnType<typeof setTimeout> | undefined;
      let sessionDeadline: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (connectDeadline) clearTimeout(connectDeadline);
        if (sessionDeadline) clearTimeout(sessionDeadline);
        upstreamAbort.signal.removeEventListener("abort", cleanup);
        removeClientAbortListener();
      };
      upstreamAbort.signal.addEventListener("abort", cleanup, { once: true });
      connectDeadline = setTimeout(() => upstreamAbort.abort(new Error("gateway_connect_timeout")), 5_000);
      try {
        const upstream = await fetch(`${base}/api/v1/stream/sse`, {
          method: "GET",
          cache: "no-store",
          redirect: "manual",
          headers: { accept: "text/event-stream", authorization: `Bearer ${auth.token}` },
          signal: upstreamAbort.signal,
        });
        if (connectDeadline) clearTimeout(connectDeadline);
        if (!upstream.ok || !upstream.body) {
          cleanup();
          return NextResponse.json(
            { error: "market_stream_unavailable", status: upstream.status },
            { status: upstream.ok ? 502 : upstream.status, headers: { "Cache-Control": "no-store" } },
          );
        }
        const remainingSessionMs = auth.principal.sessionExpiresAt - Date.now();
        if (remainingSessionMs <= 0) {
          cleanup();
          upstreamAbort.abort(new Error("session_expired"));
          return NextResponse.json({ error: "authentication_required" }, { status: 401 });
        }
        sessionDeadline = setTimeout(
          () => upstreamAbort.abort(new Error("session_expired")),
          remainingSessionMs,
        );

        const reader = upstream.body.getReader();
        const authorizedStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                cleanup();
                controller.close();
              } else {
                controller.enqueue(value);
              }
            } catch {
              cleanup();
              controller.close();
            }
          },
          async cancel(reason) {
            cleanup();
            upstreamAbort.abort(reason);
            await reader.cancel(reason).catch(() => undefined);
          },
        });

        return new Response(authorizedStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      } catch {
        cleanup();
        return NextResponse.json(
          { error: "market_stream_unavailable" },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
    },
    () => new Response(null, { status: 499 }),
  );
}
