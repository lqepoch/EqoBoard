// Test fixture: writes far more to stdout than any reply may contain. The worker must kill it.
export default {
  id: "fixture-noisy",
  async evaluate({ candles }) {
    process.stdout.write("x".repeat(200_000));
    return { plots: { noisy: { data: candles.map((bar) => ({ time: bar.openTime, value: 1 })) } } };
  },
};
