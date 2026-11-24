// The only place where adapters are wired to slices.
export { createClaudeCodeRuntime } from "./adapters/agent/claude-code/index.js";
// The loop-guard settings to run Claude Code calls under; the runtime owns the timeout, so the
// guard's timeout is a backstop.
export { claudeCodeGuardDefaults } from "./slices/execution/index.js";
