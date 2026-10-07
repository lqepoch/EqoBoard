import { describe, expect, it } from "vitest";
import { OFFLINE_MARKET_SOURCE_LABEL, resolveMarketSource } from "./market-source.js";

describe("trusted market source metadata", () => {
  it("accepts only matching Alpaca protocol labels and the explicit offline marker", () => {
    expect(resolveMarketSource({ source_mode: "alpaca", source_label: "Alpaca SIP" }, "sip"))
      .toEqual({ mode: "alpaca", label: "Alpaca SIP" });
    expect(resolveMarketSource({ source_mode: "alpaca", source_label: "Alpaca OPRA" }, "opra"))
      .toEqual({ mode: "alpaca", label: "Alpaca OPRA" });
    expect(resolveMarketSource({ source_mode: "offline_mock", source_label: OFFLINE_MARKET_SOURCE_LABEL }, "sip"))
      .toEqual({ mode: "offline_mock", label: OFFLINE_MARKET_SOURCE_LABEL });
  });

  it("does not infer a real source from the protocol or preserve mismatched claims", () => {
    expect(resolveMarketSource(undefined, "sip")).toEqual({ mode: "unknown", label: "source unknown" });
    expect(resolveMarketSource({ source_mode: "alpaca", source_label: "Alpaca OPRA" }, "sip"))
      .toEqual({ mode: "unknown", label: "source unknown" });
    expect(resolveMarketSource({ source_mode: "offline_mock", source_label: "Alpaca SIP" }, "sip"))
      .toEqual({ mode: "unknown", label: "source unknown" });
    expect(resolveMarketSource({ source_mode: "alpaca", source_label: null }, "opra"))
      .toEqual({ mode: "unknown", label: "source unknown" });
  });
});
