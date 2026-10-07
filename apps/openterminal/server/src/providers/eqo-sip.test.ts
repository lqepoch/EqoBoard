import { afterEach, describe, expect, it, vi } from "vitest";
import { SipGatewayError, sipBars, sipSnapshots } from "./eqo-sip.js";

const auth = "Bearer test-market-read-token";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("EqoBoard SIP provider", () => {
  it("splits snapshot symbols into requests of at most 50 and never loses nulls", async () => {
    vi.stubEnv("EQO_RUST_URL", "http://gateway.test/");
    const requested: string[][] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(auth);
      const url = new URL(String(input));
      const symbols = url.searchParams.get("symbols")!.split(",");
      requested.push(symbols);
      return Response.json({
        feed: "sip",
        snapshots: symbols.map((symbol, index) => ({
          symbol, last: index === 0 ? null : 100, previous_close: 99,
          change_percent: null, open: null, high: null, low: null,
          bid: null, ask: null, volume: null,
          quote_at: null, trade_at: null, daily_bar_at: null, previous_daily_bar_at: null,
          last_as_of: null, last_basis: "unknown", updated_at: null,
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const symbols = Array.from({ length: 51 }, (_, index) => `T${String(index).padStart(3, "0")}`);
    const result = await sipSnapshots(symbols, auth);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requested.map((batch) => batch.length).sort((a, b) => a - b)).toEqual([1, 50]);
    expect(result).toHaveLength(51);
    expect(result.some((snapshot) => snapshot.last === null && snapshot.last_as_of === null)).toBe(true);
  });

  it("surfaces Rust 401/403 instead of trying a public quote provider", async () => {
    vi.stubEnv("EQO_RUST_URL", "http://gateway.test");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "not entitled" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sipSnapshots(["QQQ"], auth)).rejects.toMatchObject({
      status: 403,
      message: "Rust SIP market-data gateway returned HTTP 403",
    } satisfies Partial<SipGatewayError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts only SIP bars for earnings price changes", async () => {
    vi.stubEnv("EQO_RUST_URL", "http://gateway.test");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      feed: "sip",
      bars: [{ time: "2026-10-06T20:00:00Z", open: 100, high: 103, low: 99, close: 102, volume: 42 }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const bars = await sipBars("QQQ", "1Day", 252, 390, auth);
    expect(bars.bars[0].close).toBe(102);
    expect(String(fetchMock.mock.calls[0][0])).toContain("timeframe=1Day");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ feed: "iex", bars: [] }));
    await expect(sipBars("QQQ", "1Day", 252, 390, auth)).rejects.toMatchObject({ status: 502 });
  });

  it("requires a caller-supplied verified bearer and validates the 50-symbol route contract", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sipSnapshots(["QQQ"], "")).rejects.toMatchObject({ status: 401 });
    await expect(sipSnapshots(["bad symbol"], auth)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
