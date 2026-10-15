import { MarketStore } from "../../stores/market/market-store";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BATCH_EVENTS = 256;

export function parseGatewayEventBatch(data: string): readonly unknown[] | null {
  if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > MAX_FRAME_BYTES)
    return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed) || parsed.length > MAX_BATCH_EVENTS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type MarketEventSource = Pick<
  EventSource,
  "close" | "addEventListener" | "removeEventListener"
>;
export type MarketEventSourceFactory = (url: string) => MarketEventSource;

/** One same-origin EventSource endpoint shared by every mounted market widget. */
export function attachMarketEventStream(
  store: MarketStore,
  factory: MarketEventSourceFactory = (url) => new EventSource(url, { withCredentials: true }),
): () => void {
  store.setTransport("connecting");
  let source: MarketEventSource;
  try {
    source = factory("/api/eqo/live");
  } catch {
    store.setTransport("unavailable", "stream-unavailable");
    return () => undefined;
  }

  const onOpen = () => store.setTransport("connected");
  const onError = () => store.setTransport("reconnecting", "stream-error");
  const onMessage = (event: Event) => {
    const data = (event as MessageEvent<unknown>).data;
    if (typeof data !== "string") return;
    const batch = parseGatewayEventBatch(data);
    if (batch) store.acceptBatch(batch);
  };

  source.addEventListener("open", onOpen);
  source.addEventListener("error", onError);
  source.addEventListener("message", onMessage);

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    source.removeEventListener("open", onOpen);
    source.removeEventListener("error", onError);
    source.removeEventListener("message", onMessage);
    source.close();
    store.setTransport("idle");
  };
}
