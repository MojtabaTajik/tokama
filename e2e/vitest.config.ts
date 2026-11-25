import { defineConfig } from "vitest/config";

// The real end-to-end tests: real Claude Code, real engine, real git. Each test starts its own
// engine, so they run one after another. Never part of `pnpm test`, `pnpm test:all` or CI.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["*.e2e.ts"],
    fileParallelism: false,
    // Hard limit of one test; the tests keep a shorter deadline of their own so they can clean up.
    testTimeout: 360_000,
    hookTimeout: 60_000,
  },
});
