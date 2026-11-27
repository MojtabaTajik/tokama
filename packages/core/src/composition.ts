// The only place where adapters are wired to slices.
export { CLAUDE_CODE_COMMAND, claudeCodeLaunch, claudeCodeStatus, createClaudeCodeRuntime, readClaudePlanCache, repoOfProject, requestClaudePlan, scanClaudeLogs, SHELL_CALLS_FROM, LOGIN_COMMAND, UPDATE_COMMAND } from "./adapters/agent/claude-code/index.js";
// The loop-guard settings to run Claude Code calls under; the runtime owns the timeout, so the
// guard's timeout is a backstop.
export { claudeCodeGuardDefaults } from "./slices/execution/index.js";
