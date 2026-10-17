// Test fixture: never returns, so the worker must be killed at its time limit.
export default {
  id: "fixture-spin",
  async evaluate() {
    for (;;) {
      // busy loop
    }
  },
};
