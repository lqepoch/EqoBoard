import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { parseYfinanceDailyInput } = await import("./yfinance-daily");

function request(query: string): Request {
  return new Request(`https://terminal.example/api/research/yfinance/daily${query}`);
}

const base = "?symbols=AAPL&asset_class=stock&start_utc=2025-01-01T00%3A00%3A00Z&end_utc=2025-02-01T00%3A00%3A00Z&adjustment=unadjusted";

describe("fixed Yahoo daily request parser", () => {
  it("accepts one bounded symbol and returns the typed source query", () => {
    expect(parseYfinanceDailyInput(request(base))).toMatchObject({
      ok: true,
      input: {
        symbol: "AAPL",
        assetClass: "stock",
        startUtc: "2025-01-01T00:00:00Z",
        endUtc: "2025-02-01T00:00:00Z",
        adjustment: "unadjusted",
      },
    });
  });

  it("rejects arbitrary, duplicate, and multi-symbol query keys", () => {
    expect(parseYfinanceDailyInput(request(`${base}&url=https%3A%2F%2Fevil.example`))).toMatchObject({ ok: false, status: 400 });
    expect(parseYfinanceDailyInput(request(`${base}&symbols=MSFT`))).toMatchObject({ ok: false, status: 400 });
    expect(parseYfinanceDailyInput(request(base.replace("AAPL", "AAPL%2CMSFT")))).toMatchObject({ ok: false, status: 422 });
  });

  it("rejects oversized continuation cursors and invalid time windows", () => {
    const cursor = "x".repeat(8_193);
    expect(parseYfinanceDailyInput(request(`${base}&cursor=${cursor}`))).toMatchObject({ ok: false, status: 400 });
    expect(parseYfinanceDailyInput(request(base.replace("2025-02-01", "2024-12-01")))).toMatchObject({ ok: false, status: 400 });
  });
});
