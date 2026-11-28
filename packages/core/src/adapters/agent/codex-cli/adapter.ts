// Codex CLI as one AI CLI adapter: everything the engine asks of a CLI, from the functions of this folder.
import type { AiCliAdapter } from "../../../kernel/ports/index.js";
import { codexCliLaunch } from "./launch.js";
import { createCodexCliRuntime } from "./runtime.js";
import { codexCliStatus } from "./status.js";
import { CODEX_MIN, LOGIN_COMMAND, UPDATE_COMMAND } from "./version.js";

export const codexCliAdapter: AiCliAdapter = {
  kind: "ai-cli",
  id: "codex-cli",
  name: "Codex CLI",
  description: "Coding agent CLI from OpenAI. Reads code, edits files, runs commands inside its own sandbox.",
  loginCommand: LOGIN_COMMAND,
  updateCommand: UPDATE_COMMAND,
  minimumVersion: CODEX_MIN,
  createRuntime: () => createCodexCliRuntime(),
  status: (options) => codexCliStatus(options),
  launch: codexCliLaunch,
};
