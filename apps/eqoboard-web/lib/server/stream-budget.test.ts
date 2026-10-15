import { afterEach, describe, expect, it } from "vitest";
import type { ServerPrincipal } from "./auth";
import { acquireLiveStreamSlot, resetLiveStreamBudgetForTests } from "./stream-budget";

const principal = (subject: string): ServerPrincipal => ({
  identityIssuer: "https://issuer.example",
  subject,
  permissions: ["market:stream"],
  sessionExpiresAt: Date.now() + 60_000,
});

afterEach(resetLiveStreamBudgetForTests);

describe("live stream resource budget", () => {
  it("caps each principal and releases a slot once", () => {
    const first = acquireLiveStreamSlot(principal("one"));
    const second = acquireLiveStreamSlot(principal("one"));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(acquireLiveStreamSlot(principal("one"))).toBeNull();
    first?.();
    first?.();
    expect(acquireLiveStreamSlot(principal("one"))).not.toBeNull();
  });
});
