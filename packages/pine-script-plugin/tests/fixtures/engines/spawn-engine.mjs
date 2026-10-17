// Test fixture: tries to start a process. Under --permission this must be denied and reported as a failure.
import { spawnSync } from "node:child_process";
export default {
  id: "fixture-spawn",
  async evaluate() {
    spawnSync("sh", ["-c", "echo escaped"]);
    return { plots: {} };
  },
};
