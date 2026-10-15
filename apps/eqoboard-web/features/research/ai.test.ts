import { describe, expect, it } from "vitest";

import { parseResearchAiRequest, parseResearchAiResponse } from "./ai";

describe("bounded AI research action contract", () => {
  it("accepts a bounded user prompt and retains provider-generated evidence", () => {
    expect(
      parseResearchAiRequest({
        messages: [{ role: "user", content: "Summarize the research I pasted." }],
      }).ok,
    ).toBe(true);
    expect(
      parseResearchAiResponse({
        schemaVersion: 1,
        text: "Unverified analysis.",
        generatedAt: "2026-10-15T02:00:00.000Z",
        provider: "Anthropic",
      })?.provider,
    ).toBe("Anthropic");
    expect(
      parseResearchAiResponse({
        schemaVersion: 1,
        text: "  ",
        generatedAt: "2026-10-15T02:00:00.000Z",
        provider: "Anthropic",
      }),
    ).toBeNull();
  });

  it("rejects nonalternating, oversized and non-user-final conversations", () => {
    expect(
      parseResearchAiRequest({
        messages: [
          { role: "user", content: "One" },
          { role: "user", content: "Two" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseResearchAiRequest({ messages: [{ role: "assistant", content: "Not a prompt" }] }).ok,
    ).toBe(false);
    expect(
      parseResearchAiRequest({ messages: [{ role: "user", content: "x".repeat(4_001) }] }).ok,
    ).toBe(false);
    expect(parseResearchAiRequest({ messages: [{ role: "user", content: "x\u0000y" }] }).ok).toBe(
      false,
    );
  });
});
