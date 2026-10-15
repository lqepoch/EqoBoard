import type { ResearchOperationName } from "./types";

export type ResearchOperationInput =
  | Readonly<{ operation: "news"; symbol?: string }>
  | Readonly<{ operation: "macro"; region: "us" | "eu" }>
  | Readonly<{ operation: "economic-calendar" }>
  | Readonly<{ operation: "earnings-calendar"; symbols?: readonly string[] }>
  | Readonly<{ operation: "earnings-history"; symbol: string }>
  | Readonly<{ operation: "insider"; symbol: string }>
  | Readonly<{ operation: "screener"; market: "us" | "eu"; sector?: string; marketCapMin?: number; changeMin?: number; changeMax?: number; volumeMin?: number; sort?: "marketCap" | "price" | "changePercent" | "volume"; direction?: "asc" | "desc"; limit?: number }>
  | Readonly<{ operation: "heatmap"; market: "us" | "eu" }>
  | Readonly<{ operation: "crypto" }>
  | Readonly<{ operation: "crypto-global" }>;

export type ResearchInputParseResult =
  | Readonly<{ ok: true; value: ResearchOperationInput }>
  | Readonly<{ ok: false; error: "unknown-operation" | "unknown-parameter" | "invalid-parameter" }>;

const OPERATIONS: readonly ResearchOperationName[] = Object.freeze([
  "news", "macro", "economic-calendar", "earnings-calendar", "earnings-history", "insider",
  "screener", "heatmap", "crypto", "crypto-global",
]);

function exactKeys(params: URLSearchParams, allowed: readonly string[]): boolean {
  for (const key of params.keys()) if (!allowed.includes(key)) return false;
  return true;
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : values.length === 0 ? null : "";
}

function symbol(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.^-]{0,15}$/u.test(normalized) ? normalized : null;
}

function market(value: string | null): "us" | "eu" | null {
  return value === "us" || value === "eu" ? value : null;
}

function finite(params: URLSearchParams, name: string, min: number, max: number): number | undefined | null {
  const value = single(params, name);
  if (value === null) return undefined;
  if (value === "" || !/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= min && result <= max ? result : null;
}

function symbols(params: URLSearchParams): readonly string[] | null | undefined {
  const values = params.getAll("symbols");
  if (values.length === 0) return undefined;
  if (values.length > 30) return null;
  const list = values.flatMap((value) => value.split(",")).map((value) => symbol(value));
  if (list.length > 30 || list.some((value) => value === null)) return null;
  const unique = [...new Set(list as string[])];
  return unique.length === list.length ? unique : null;
}

/** Parse a request query against the exact per-operation input allowlist. */
export function parseResearchOperationInput(
  operation: string,
  params: URLSearchParams,
): ResearchInputParseResult {
  if (!OPERATIONS.includes(operation as ResearchOperationName)) return { ok: false, error: "unknown-operation" };
  switch (operation as ResearchOperationName) {
    case "news": {
      if (!exactKeys(params, ["symbol"])) return { ok: false, error: "unknown-parameter" };
      const raw = single(params, "symbol");
      if (raw === null) return { ok: true, value: { operation: "news" } };
      const parsed = symbol(raw);
      return parsed ? { ok: true, value: { operation: "news", symbol: parsed } } : { ok: false, error: "invalid-parameter" };
    }
    case "macro": {
      if (!exactKeys(params, ["region"])) return { ok: false, error: "unknown-parameter" };
      const region = single(params, "region");
      return region === "us" || region === "eu"
        ? { ok: true, value: { operation: "macro", region } }
        : { ok: false, error: "invalid-parameter" };
    }
    case "economic-calendar":
      return params.size === 0
        ? { ok: true, value: { operation: "economic-calendar" } }
        : { ok: false, error: "unknown-parameter" };
    case "earnings-calendar": {
      if (!exactKeys(params, ["symbols"])) return { ok: false, error: "unknown-parameter" };
      const list = symbols(params);
      return list === null
        ? { ok: false, error: "invalid-parameter" }
        : { ok: true, value: { operation: "earnings-calendar", ...(list ? { symbols: list } : {}) } };
    }
    case "earnings-history":
    case "insider": {
      if (!exactKeys(params, ["symbol"])) return { ok: false, error: "unknown-parameter" };
      const parsed = symbol(single(params, "symbol"));
      return parsed
        ? { ok: true, value: { operation, symbol: parsed } as ResearchOperationInput }
        : { ok: false, error: "invalid-parameter" };
    }
    case "screener": {
      const keys = ["market", "sector", "marketCapMin", "changeMin", "changeMax", "volumeMin", "sort", "direction", "limit"];
      if (!exactKeys(params, keys)) return { ok: false, error: "unknown-parameter" };
      const marketValue = market(single(params, "market"));
      const sectorRaw = single(params, "sector");
      const sector = sectorRaw === null ? undefined : sectorRaw.trim();
      const marketCapMin = finite(params, "marketCapMin", 0, 1e16);
      const changeMin = finite(params, "changeMin", -100, 1000);
      const changeMax = finite(params, "changeMax", -100, 1000);
      const volumeMin = finite(params, "volumeMin", 0, 1e16);
      const limitValue = finite(params, "limit", 1, 500);
      const sortRaw = single(params, "sort");
      const directionRaw = single(params, "direction");
      const sort = sortRaw === null ? undefined : sortRaw;
      const direction = directionRaw === null ? undefined : directionRaw;
      if (!marketValue || sectorRaw === "" || (sector !== undefined && (sector.length === 0 || sector.length > 64 || /[\u0000-\u001f\u007f]/u.test(sector))) ||
          [marketCapMin, changeMin, changeMax, volumeMin, limitValue].some((item) => item === null) ||
          (sort !== undefined && !["marketCap", "price", "changePercent", "volume"].includes(sort)) ||
          (direction !== undefined && direction !== "asc" && direction !== "desc") ||
          (typeof changeMin === "number" && typeof changeMax === "number" && changeMin > changeMax) ||
          (typeof limitValue === "number" && !Number.isInteger(limitValue))) {
        return { ok: false, error: "invalid-parameter" };
      }
      return {
        ok: true,
        value: {
          operation: "screener", market: marketValue,
          ...(sector === undefined ? {} : { sector }),
          ...(marketCapMin === undefined ? {} : { marketCapMin }),
          ...(changeMin === undefined ? {} : { changeMin }),
          ...(changeMax === undefined ? {} : { changeMax }),
          ...(volumeMin === undefined ? {} : { volumeMin }),
          ...(sort === undefined ? {} : { sort: sort as "marketCap" | "price" | "changePercent" | "volume" }),
          ...(direction === undefined ? {} : { direction: direction as "asc" | "desc" }),
          ...(limitValue === undefined ? {} : { limit: limitValue }),
        },
      };
    }
    case "heatmap": {
      if (!exactKeys(params, ["market"])) return { ok: false, error: "unknown-parameter" };
      const marketValue = market(single(params, "market"));
      return marketValue ? { ok: true, value: { operation: "heatmap", market: marketValue } } : { ok: false, error: "invalid-parameter" };
    }
    case "crypto":
    case "crypto-global":
      return params.size === 0 ? { ok: true, value: { operation } } : { ok: false, error: "unknown-parameter" };
  }
}
