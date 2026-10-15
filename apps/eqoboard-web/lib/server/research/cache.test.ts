import { afterEach, describe, expect, it } from "vitest";

import { clearResearchCacheForTests, getCached, researchCacheSizeForTests } from "./cache";

afterEach(() => clearResearchCacheForTests());

describe("bounded research response cache", () => {
  it("reuses a fresh value and reloads after its explicit TTL", async () => {
    let loads = 0;
    const load = async () => ({ revision: ++loads });

    await expect(getCached("news:SPY", 100, load, 1_000)).resolves.toMatchObject({ value: { revision: 1 }, cache: "miss" });
    await expect(getCached("news:SPY", 100, load, 1_050)).resolves.toMatchObject({ value: { revision: 1 }, cache: "hit" });
    await expect(getCached("news:SPY", 100, load, 1_100)).resolves.toMatchObject({ value: { revision: 2 }, cache: "miss" });
    expect(loads).toBe(2);
  });

  it("coalesces concurrent reads by key and does not cache rejected provider work", async () => {
    let loads = 0;
    let release!: (value: string) => void;
    const load = () => {
      loads += 1;
      return new Promise<string>((resolve) => { release = resolve; });
    };
    const first = getCached("macro:us", 1_000, load, 2_000);
    const second = getCached("macro:us", 1_000, load, 2_000);
    expect(loads).toBe(1);
    release("observation");
    await expect(first).resolves.toMatchObject({ value: "observation", cache: "miss" });
    await expect(second).resolves.toMatchObject({ value: "observation", cache: "hit" });

    await expect(getCached("failed", 1_000, async () => { throw new Error("provider down"); }, 2_000)).rejects.toThrow("provider down");
    expect(researchCacheSizeForTests()).toBe(1);
  });

  it("bounds retained keys and rejects unbounded cache requests", async () => {
    for (let index = 0; index < 260; index += 1) {
      await getCached(`key-${index}`, 5_000, async () => index, 3_000);
    }
    expect(researchCacheSizeForTests()).toBe(256);
    await expect(getCached("x".repeat(257), 1_000, async () => null)).rejects.toThrow("invalid-research-cache-request");
  });
});
