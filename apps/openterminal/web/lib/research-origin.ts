const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validate the optional, navigation-only OpenBB Workspace origin. */
export function validatePublicResearchOrigin(
  raw: string | undefined,
  terminalOrigin: string | null,
): string | null {
  if (!raw || !terminalOrigin) return null;
  try {
    const url = new URL(raw);
    const terminal = new URL(terminalOrigin);
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    const normalizeHost = (host: string) => host.toLowerCase().replace(/\.$/, "");

    if (url.origin !== raw || url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (normalizeHost(url.hostname) === normalizeHost(terminal.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}
