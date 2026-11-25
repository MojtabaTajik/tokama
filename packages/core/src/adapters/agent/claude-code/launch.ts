// What a Claude Code call runs, for a page that shows it. Built from the same functions the runtime
// uses (`argGroups`, the env allowlist), with placeholders where a step supplies the value, so the
// text cannot drift from what runs. Holds no values: not a role, not a settings path, not an env value.
import { ENV_ALLOWLIST } from "../../../kernel/process/index.js";
import { READ_ONLY } from "../../../kernel/ports/index.js";
import { argGroups } from "./args.js";
import { LOGIN_COMMAND } from "./status.js";

export interface ClaudeCodeLaunch {
  /** The executable, looked up on the allowlisted PATH. */
  readonly command: string;
  readonly headlessArgs: readonly string[];
  readonly modelArgs: readonly string[];
  /** For a read-only step. A step that may edit, run commands or use the web adds tools and rules. */
  readonly permissionArgs: readonly string[];
  /** The step's prompt goes to standard input; the agent's role is an argument. */
  readonly promptVia: "stdin";
  readonly roleArgs: readonly string[];
  /** Names only. These are the only variables the CLI gets from Tokama's own environment. */
  readonly envNames: readonly string[];
  readonly loginCommand: string;
}

export const CLAUDE_CODE_COMMAND = "claude";

export function claudeCodeLaunch(): ClaudeCodeLaunch {
  const groups = argGroups({ model: "{model}", prompt: "", cwd: "", role: "{role}", limits: READ_ONLY });
  // The sample request is fixed and valid.
  if (!groups.ok) throw new Error(groups.error);
  return {
    command: CLAUDE_CODE_COMMAND,
    headlessArgs: groups.value.headless,
    modelArgs: groups.value.model,
    permissionArgs: groups.value.permission,
    promptVia: "stdin",
    roleArgs: groups.value.instructions,
    envNames: [...ENV_ALLOWLIST],
    loginCommand: LOGIN_COMMAND,
  };
}
