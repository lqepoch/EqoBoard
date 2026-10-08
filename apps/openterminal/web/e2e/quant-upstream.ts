/** Explicit loopback-only override for local Quant API integration tests. */
export function quantUpstreamUrl(raw: string | undefined, fallbackPort: number): string {
  if (raw === undefined) return `http://127.0.0.1:${fallbackPort}`;
  if (!raw || raw.length > 2_048 || raw.trim() !== raw) {
    throw new Error("E2E_QUANT_UPSTREAM_URL must be a loopback HTTP origin");
  }
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "http:" || !loopback || url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash || (raw !== url.origin && raw !== `${url.origin}/`)) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new Error("E2E_QUANT_UPSTREAM_URL must be a loopback HTTP origin");
  }
}
