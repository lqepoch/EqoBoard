import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { environment: "node", include: ["**/*.test.ts", "**/*.test.tsx"], exclude: ["node_modules/**", ".next/**", "e2e/**"], testTimeout: 15000, hookTimeout: 15000, pool: "forks", maxWorkers: 2 },
});
