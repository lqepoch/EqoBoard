import { afterEach, describe, expect, it, vi } from "vitest";

import { readSipSnapshotsWithDelegation } from "./gateway";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("research Gateway URL policy", () => {
  it("rejects an untrusted HTTP authority before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("EQO_RUST_URL", "http://attacker.example");

    const result = await readSipSnapshotsWithDelegation({ token: "test-delegation" }, ["AAPL"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a missing Gateway URL unavailable instead of using the shared parser default", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("EQO_RUST_URL", "");

    const result = await readSipSnapshotsWithDelegation({ token: "test-delegation" }, ["AAPL"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
