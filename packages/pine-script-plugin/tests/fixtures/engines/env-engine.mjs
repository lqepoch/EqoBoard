// Test fixture: reports which environment variables are visible, through a plot title (bounded and checked).
export default {
  id: "fixture-env",
  async evaluate({ candles }) {
    const keys = Object.keys(process.env).sort().join(",").slice(0, 120) || "none";
    return { plots: { [keys]: { data: candles.map((bar) => ({ time: bar.openTime, value: 1 })) } } };
  },
};
