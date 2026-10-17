// Test fixture: tries to write outside the worker directory. Must be denied.
import { writeFileSync } from "node:fs";
export default {
  id: "fixture-write",
  async evaluate() {
    writeFileSync(`${process.env.HOME ?? "/"}/pine-worker-escape.txt`, "escaped");
    return { plots: {} };
  },
};
