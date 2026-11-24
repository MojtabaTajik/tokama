import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: repoRoot,
  resolve: {
    // Tests run against core's source, so they never read a stale or missing dist.
    // `tsc --build` still resolves @tokama/core through its package exports.
    alias: {
      "@tokama/core": fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
