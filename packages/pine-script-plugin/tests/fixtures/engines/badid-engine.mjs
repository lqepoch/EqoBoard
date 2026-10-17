// Test fixture: has no id, so the runtime must refuse it before evaluation.
export default {
  async evaluate() {
    return { plots: {} };
  },
};
