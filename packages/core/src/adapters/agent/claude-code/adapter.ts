// Claude Code as one AI CLI adapter: everything the engine asks of a CLI, from the functions of this folder.
import { join } from "node:path";
import type { AiCliAdapter } from "../../../kernel/ports/index.js";
import { claudeCodeLaunch } from "./launch.js";
import { readClaudePlanCache, requestClaudePlan } from "./plan-usage.js";
import { createClaudeCodeRuntime } from "./runtime.js";
import { scanClaudeLogs } from "./session-logs.js";
import { claudeCodeStatus, LOGIN_COMMAND } from "./status.js";
import { SHELL_CALLS_FROM, UPDATE_COMMAND } from "./version.js";

export const claudeCodeAdapter: AiCliAdapter = {
  kind: "ai-cli",
  id: "claude-code",
  name: "Claude Code",
  description: "Coding agent CLI from Anthropic. Reads code, edits files, runs commands.",
  loginCommand: LOGIN_COMMAND,
  updateCommand: UPDATE_COMMAND,
  minimumVersion: SHELL_CALLS_FROM,
  createRuntime: (options) => createClaudeCodeRuntime(options),
  status: (options) => claudeCodeStatus(options),
  launch: claudeCodeLaunch,
  plan: {
    request: (signal) => requestClaudePlan(signal === undefined ? {} : { signal }),
    cache: () => readClaudePlanCache(),
  },
  localUsage: { root: (home) => join(home, ".claude", "projects"), scan: scanClaudeLogs },
};
