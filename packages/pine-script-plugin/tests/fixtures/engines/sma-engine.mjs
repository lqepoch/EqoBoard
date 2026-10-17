// Test fixture only: a reviewed-by-test SMA(2) engine. It exists to exercise the worker pipeline, not as a Pine engine.
export default {
  id: "fixture-sma-2",
  async evaluate({ candles }) {
    const data = candles.map((bar, index) => ({
      time: bar.openTime,
      value: index < 1 ? null : (candles[index].close + candles[index - 1].close) / 2,
    }));
    return { plots: { SMA: { data, options: { overlay: true } } } };
  },
};
