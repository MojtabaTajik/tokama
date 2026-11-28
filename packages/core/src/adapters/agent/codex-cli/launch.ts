// What a Codex CLI call runs, for a page that shows it. Built from the same function the runtime
// uses (`argGroups`), with placeholders where a step supplies the value, so the text cannot drift
// from what runs. Holds no values: not a role, not a settings path, not an env value.
import { ENV_ALLOWLIST } from "../../../kernel/process/index.js";
import { READ_ONLY, type AiCliLaunch } from "../../../kernel/ports/index.js";
import { argGroups } from "./args.js";
import { CODEX_CLI_COMMAND } from "./command.js";

export function codexCliLaunch(): AiCliLaunch {
  const groups = argGroups({ model: "{model}", prompt: "", cwd: "{cwd}", role: "{role}", limits: READ_ONLY });
  // The sample request is fixed and valid.
  if (!groups.ok) throw new Error(groups.error);
  return {
    command: CODEX_CLI_COMMAND,
    headlessArgs: groups.value.headless,
    modelArgs: groups.value.model,
    permissionArgs: groups.value.permission,
    promptVia: "stdin",
    roleArgs: groups.value.instructions,
    envNames: [...ENV_ALLOWLIST],
  };
}
