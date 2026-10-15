import { describe, expect, it } from "vitest";
import { parseCoreBarsPageRequest } from "./core-bars";

function request(query = "") {
  return new Request(`https://terminal.example/api/history/AAPL${query}`);
}

describe("Core Bars V1 request boundary", () => {
  it("resolves a bounded first-page window and records all selected inputs", () => {
    const parsed = parseCoreBarsPageRequest(request("?range=1M&session_scope=regular&adjustment=split"), "aapl",
      new Date("2026-10-15T12:00:00.000Z"));
    expect(parsed).toMatchObject({
      ok: true,
      symbol: "AAPL",
      range: "1M",
      resolution: "1h",
      assetClass: "stock",
      sessionScope: "regular",
      adjustment: "split",
      providerMode: "auto",
      allowDailyDowngrade: true,
      cursor: null,
      requestEnd: "2026-10-15T12:00:00.000Z",
    });
    if (parsed.ok) expect(Date.parse(parsed.requestEnd) - Date.parse(parsed.requestStart)).toBeLessThanOrEqual(40 * 86_400_000);
  });

  it("requires a cursor page to repeat the exact bounded request window", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const end = "2026-10-15T12:00:00.000Z";
    const missing = parseCoreBarsPageRequest(request("?range=1Y&cursor=opaque"), "AAPL",
      new Date("2026-10-15T12:00:00.000Z"));
    expect(missing).toMatchObject({ ok: false, error: "invalid_cursor" });

    const page = parseCoreBarsPageRequest(request(`?range=1Y&cursor=opaque&request_start=${encodeURIComponent(start)}&request_end=${encodeURIComponent(end)}`), "AAPL",
      new Date("2026-10-15T12:00:00.000Z"));
    expect(page).toMatchObject({ ok: true, requestStart: start, requestEnd: end, cursor: "opaque" });
  });

  it("rejects unknown, duplicated, malformed, and overlong continuation inputs", () => {
    expect(parseCoreBarsPageRequest(request("?url=https://attacker.example"), "AAPL").ok).toBe(false);
    expect(parseCoreBarsPageRequest(request("?range=1D&range=1Y"), "AAPL").ok).toBe(false);
    expect(parseCoreBarsPageRequest(request("?range=1D&request_start=2026-01-01T00%3A00%3A00.000Z"), "AAPL").ok).toBe(false);
    const cursor = "x".repeat(2_049);
    const start = "2026-10-14T12:00:00.000Z";
    const end = "2026-10-15T12:00:00.000Z";
    const query = `?range=1D&cursor=${cursor}&request_start=${encodeURIComponent(start)}&request_end=${encodeURIComponent(end)}`;
    expect(parseCoreBarsPageRequest(request(query), "AAPL").ok).toBe(false);
  });
});
