// Test fixture: allocates until the worker heap limit is hit and the process dies without a reply.
export default {
  id: "fixture-oom",
  async evaluate() {
    const hold = [];
    for (;;) hold.push(new Array(1_000_000).fill(1));
  },
};
