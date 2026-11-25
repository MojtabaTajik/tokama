import { defineConfig } from "vitest/config";

// The UI flow tests: each test starts its own Electron app on its own sample engine, so they run
// one after another. Slow by nature, so they stay out of `pnpm test` and `pnpm test:all`.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    globalSetup: ["./global-setup.ts"],
    include: ["*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
