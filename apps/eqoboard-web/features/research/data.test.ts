import { describe, expect, it } from "vitest";

import { parseResearchEnvelope, projectResearchTable } from "./data";

const newsEnvelope = {
  schemaVersion: 1,
  operation: "news",
  source: {
    provider: "Yahoo Finance RSS + Google News RSS",
    providerUrl: "https://news.google.com/",
    sourcePath: "apps/openterminal/server/src/providers/news.ts",
    license: null,
  },
  status: "partial",
  asOf: null,
  retrievedAt: "2026-10-15T02:00:00.000Z",
  completeness: { complete: false, failedItems: 1, truncated: false },
  cache: "miss",
  data: [{
    title: "Headline",
    link: "https://news.example/story",
    publisher: "Publisher",
    provider: "Google News RSS",
    publishedAt: "2026-10-15T01:55:00.000Z",
    symbol: null,
  }],
  warning: "Provider terms are not verified.",
} as const;

describe("native research envelope adapter", () => {
  it("retains response-derived provider, as-of, retrieval, cache and completeness evidence", () => {
    const envelope = parseResearchEnvelope("research.news", newsEnvelope);

    expect(envelope?.source.provider).toBe("Yahoo Finance RSS + Google News RSS");
    expect(envelope?.asOf).toBeNull();
    expect(envelope?.retrievedAt).toBe("2026-10-15T02:00:00.000Z");
    expect(envelope?.completeness.failedItems).toBe(1);
    expect(envelope?.status).toBe("partial");
    if (!envelope) return;
    expect(projectResearchTable("research.news", envelope).rows).toHaveLength(1);
  });

  it("rejects operation/source mismatches and incomplete payloads advertised as complete", () => {
    expect(parseResearchEnvelope("research.crypto", newsEnvelope)).toBeNull();
    expect(parseResearchEnvelope("research.news", {
      ...newsEnvelope,
      status: "available",
      source: { ...newsEnvelope.source, providerUrl: "javascript:alert(1)" },
    })).toBeNull();
    expect(parseResearchEnvelope("research.news", {
      ...newsEnvelope,
      status: "available",
      completeness: { ...newsEnvelope.completeness, complete: true },
      data: [{ ...newsEnvelope.data[0]!, link: "javascript:alert(1)" }],
    })).toBeNull();
  });
});
