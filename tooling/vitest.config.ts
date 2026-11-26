import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Two projects: `fast` is every test that stays in memory or runs only a one-shot helper command;
// `int` (`*.int.test.ts`) is every test that starts real git repos, engines or processes.
// `pnpm test` runs fast, `pnpm test:int` runs int, `pnpm test:all` runs both.
const roots = ["packages/*/src/**", "apps/*/src/**", "apps/*/scripts", "tooling", "tooling/removal-test"];
const pattern = (suffix: string) => roots.map((root) => `${root}/${suffix}`);

export default defineConfig({
  root: repoRoot,
  resolve: {
    // Tests run against core's and the client's source, so they never read a stale or missing dist.
    // `tsc --build` still resolves @tokama/core through its package exports.
    alias: {
      "@tokama/core": fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url)),
      "@tokama/client": fileURLToPath(new URL("../packages/client/src/index.ts", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "fast", include: pattern("*.test.{ts,tsx}"), exclude: pattern("*.int.test.ts") },
      },
      { extends: true, test: { name: "int", include: pattern("*.int.test.ts") } },
    ],
  },
});
