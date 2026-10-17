// Test fixture: unbounded recursion, which must surface as a generic engine failure.
function down(n) {
  return down(n + 1) + 1;
}
export default {
  id: "fixture-deep",
  async evaluate() {
    return { plots: { deep: { data: [{ time: 0, value: down(0) }] } } };
  },
};
