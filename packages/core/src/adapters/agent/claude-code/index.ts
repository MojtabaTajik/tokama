// Claude Code as one AI CLI adapter: what the engine reads from it.
export { claudeCodeAdapter } from "./adapter.js";
// AgentRuntime for Claude Code: one headless `claude -p` call per launch.
export { createClaudeCodeRuntime, type ClaudeCodeOptions } from "./runtime.js";
// Installed and logged in, read-only.
export { claudeCodeStatus, LOGIN_COMMAND, type ClaudeCodeStatusOptions } from "./status.js";
// The oldest Claude Code that runs commands inside its sandbox, and the commands to sign in and to update; the window shows them in its checklist.
export { SHELL_CALLS_FROM, UPDATE_COMMAND } from "./version.js";
// Plan windows: Claude Code's own usage answer, then its cached copy.
export { readClaudePlanCache, requestClaudePlan, type ClaudePlan, type ClaudePlanOptions } from "./plan-usage.js";
// Usage on this machine from Claude Code's session logs: usage fields only, never message content.
export { parseLogLine, projectKey, scanClaudeLogs, type LoggedUsage, type LogMark, type ScanLogsOptions, type ScanLogsResult } from "./session-logs.js";
// What a call runs (arguments, instructions, environment names), for the AI CLIs page.
export { CLAUDE_CODE_COMMAND } from "./command.js";
export { claudeCodeLaunch, type ClaudeCodeLaunch } from "./launch.js";
