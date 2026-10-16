/** Provider observations are separate from the pinned Core financial contracts. */
export type ResearchOperationName =
  | "news"
  | "macro"
  | "economic-calendar"
  | "earnings-calendar"
  | "earnings-history"
  | "insider"
  | "screener"
  | "heatmap"
  | "recap"
  | "symbol-search"
  | "crypto"
  | "crypto-global";

export type ResearchSource = Readonly<{
  provider: string;
  providerUrl: string;
  sourcePath: string;
  license: string | null;
}>;

export type ResearchEnvelope<T> = Readonly<{
  schemaVersion: 1;
  operation: ResearchOperationName;
  source: ResearchSource;
  status: "available" | "partial";
  /** Provider-supplied observation time. It is null when the provider has none. */
  asOf: string | null;
  /** Time this native BFF response was assembled; never a replacement for `asOf`. */
  retrievedAt: string;
  completeness: Readonly<{
    complete: boolean;
    failedItems: number | null;
    truncated: boolean;
  }>;
  /** Process-local response cache evidence. This is not a freshness claim. */
  cache: "miss" | "hit";
  data: T;
  warning: string | null;
}>;

export type ProviderResult<T> = Readonly<{
  source: ResearchSource;
  data: T;
  asOf: string | null;
  complete: boolean;
  failedItems: number | null;
  truncated: boolean;
  warning: string | null;
}>;

export class ResearchProviderError extends Error {
  constructor(
    readonly code:
      | "provider-unavailable"
      | "provider-unconfigured"
      | "provider-response-invalid"
      | "input-invalid",
    readonly status: 400 | 502 | 503,
  ) {
    super(code);
    this.name = "ResearchProviderError";
  }
}

export const SOURCE_LICENSES = Object.freeze({
  native: "MIT",
  openTerminal: "MIT",
  fastXmlParser: "MIT",
  providerUnknown: null,
});
