export class ProviderHttpError extends Error {
  constructor(readonly status: number | null, message = "provider-unavailable") {
    super(message);
    this.name = "ProviderHttpError";
  }
}

type ProviderRequest = Readonly<{
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}>;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

/** Fetch only a caller-constructed fixed-provider URL; cap time and bytes before parsing. */
export async function readProviderText(url: URL, options: ProviderRequest = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
    throw new TypeError("invalid-provider-request-bounds");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: { Accept: "application/json,text/csv,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1", ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderHttpError(null);
  }
  if (!response.ok) throw new ProviderHttpError(response.status);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new ProviderHttpError(502, "provider-response-too-large");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ProviderHttpError(502, "provider-response-too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    throw new ProviderHttpError(null);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProviderHttpError(502, "provider-response-invalid-encoding");
  }
}

export async function readProviderJson<T = unknown>(url: URL, options: ProviderRequest = {}): Promise<T> {
  const text = await readProviderText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderHttpError(502, "provider-response-invalid-json");
  }
}

/** RFC 4180-style CSV reader, including escaped quotes and quoted commas/newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/u, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new ProviderHttpError(502, "provider-response-invalid-csv");
  row.push(cell.replace(/\r$/u, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
