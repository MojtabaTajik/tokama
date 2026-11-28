import { isAbsolute } from "node:path";
import { READ_ONLY, type AgentCallRequest } from "../../../kernel/ports/index.js";
import { CREDENTIAL_PATHS } from "../../../kernel/sandbox/index.js";
import { err, ok, type Result } from "../../../kernel/result/index.js";
import { NO_DAEMON, NO_DAEMON_FEATURE } from "./command.js";
import { override, type TomlValue } from "./toml.js";

/** Tokama's own data (settings, item logs, the database). Agents never read it. */
export const DEFAULT_TOKAMA_HOME = "~/.tokama";

/** Why an agent with a list of commands cannot run on Codex CLI. */
export const COMMAND_LIST_PROBLEM =
  "Codex CLI can't limit commands to a list: it runs any command inside its sandbox, or none. Remove the agent's `commands` list to run it on Codex CLI, or run it on another CLI.";

/** The name of the permission profile Tokama defines for every call. */
const PROFILE = "tokama";

/**
 * Flags that take the sandbox, the approvals or the trust of a folder away. No call carries one:
 * `buildArgs` refuses an argv that does, so the rule holds whatever the groups below grow into.
 */
const FORBIDDEN_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "--trust", "--add-dir", "--yolo", "-s", "--sandbox", "--full-auto", "-a", "--ask-for-approval", "--profile", "-p"];
// A setting with the same effect as one of those flags: another sandbox, or a trusted folder.
const FORBIDDEN_SETTINGS = /^(?:sandbox_mode|sandbox_workspace_write|projects|trust_level)\b/;

export interface CodexArgsOptions {
  /** Tokama's folder, `~/.tokama` or absolute: closed to the agent's commands. */
  readonly tokamaHome?: string;
  /** Other absolute folders closed to the agent's commands, e.g. the engine's socket and token folder. */
  readonly closedDirs?: readonly string[];
}

/** The argv of `buildArgs`, by what each part is for. Flattened in this order, it is the argv. */
export interface ArgGroups {
  /** No terminal, no daemon, no user or repo config, and events Tokama can read. */
  readonly headless: string[];
  readonly model: string[];
  /** What the commands may do: the permission profile, approvals and the web. */
  readonly permission: string[];
  /** The agent's role. The step's prompt is not an argument: it goes to stdin. */
  readonly instructions: string[];
}

/**
 * The argv after the `codex` command for one headless call. The prompt goes to stdin (`-`).
 *
 * - `--no-daemon`, `--disable daemon_auto_start`: the call is a plain child of Tokama, not a client
 *   of Codex's background daemon, so Stop reaches everything it started.
 * - `--ignore-user-config`, `--ignore-rules`, `--disable hooks`, and never `--trust`: neither the
 *   person's config and rules nor the repo's `.codex/` config and hooks are loaded.
 *   `project_doc_max_bytes=0` leaves the repo's agent instructions out of the call.
 * - `--strict-config`: a setting this Codex does not know fails the call, where it would otherwise
 *   be ignored, and a missing guard with it.
 * - `approval_policy="never"`: a command the sandbox refuses is refused, never offered for approval.
 * - One permission profile (`default_permissions`) and never `-s`: with a profile set, the legacy
 *   sandbox settings are silently ignored. The profile closes the secret paths, the network is off,
 *   and a step that edits writes the working directory and Tokama's own temp folder (`TMPDIR`) only.
 * - Single-value flags use `--flag=value`, so a value that starts with `-` is never read as a flag.
 */
export function buildArgs(request: AgentCallRequest, options: CodexArgsOptions = {}): Result<string[], string> {
  const groups = argGroups(request, options);
  if (!groups.ok) return groups;
  const { headless, model, permission, instructions } = groups.value;
  const argv = [...headless, ...model, ...permission, ...instructions, "-"];
  const forbidden = forbiddenIn(argv);
  return forbidden === undefined ? ok(argv) : err(`Codex CLI would be called with "${forbidden}", which Tokama never passes`);
}

export function argGroups(request: AgentCallRequest, options: CodexArgsOptions = {}): Result<ArgGroups, string> {
  const limits = request.limits ?? READ_ONLY;
  if (request.model === "" || request.model.startsWith("-")) return err(`not a model name: "${request.model}"`);
  if (limits.commands.length > 0) return err(COMMAND_LIST_PROBLEM);
  const closed = closedPaths(options);
  if (!closed.ok) return closed;

  const filesystem: Record<string, TomlValue> = {
    // A path listed twice would be a duplicate key, and Codex would refuse the whole config.
    ...Object.fromEntries(closed.value.map((path) => [path, "none"])),
    ...(limits.edit ? { ":slash_tmp": "read" } : {}),
    ":workspace_roots": { "**/*.env": "none" },
  };
  const permission = overrides([
    ["approval_policy", "never"],
    ["approvals_reviewer", "user"],
    ["default_permissions", PROFILE],
    [`permissions.${PROFILE}.extends`, limits.edit ? ":workspace" : ":read-only"],
    [`permissions.${PROFILE}.filesystem`, filesystem],
    // Commands never reach the network, whatever hosts the step's sandbox lists: Codex cannot filter by host.
    [`permissions.${PROFILE}.network.enabled`, false],
    ["web_search", limits.web ? "live" : "disabled"],
  ]);
  if (!permission.ok) return permission;
  const headless = overrides([
    ["project_doc_max_bytes", 0],
    ["allow_login_shell", false],
  ]);
  if (!headless.ok) return headless;
  const role = request.role !== undefined && request.role !== "" ? overrides([["developer_instructions", request.role]]) : ok<string[]>([]);
  if (!role.ok) return role;

  return ok({
    headless: [
      ...NO_DAEMON,
      "exec",
      ...NO_DAEMON_FEATURE,
      "--disable",
      "hooks",
      // The sub-agent tools stay anyway (the model brings them); the call's loop guards count them.
      "--disable",
      "multi_agent",
      "--disable",
      "network_proxy",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--strict-config",
      "--json",
      `--cd=${request.cwd}`,
      ...headless.value,
    ],
    model: [`--model=${request.model}`],
    permission: permission.value,
    instructions: role.value,
  });
}

/** The `-c key=value` pairs of the permission profile alone: what `codex sandbox` takes to run a command under the same rules. */
export function profileOverrides(limits: { readonly edit: boolean }, options: CodexArgsOptions = {}): Result<string[], string> {
  const groups = argGroups({ model: "x", prompt: "", cwd: "", limits: { edit: limits.edit, commands: [], web: false } }, options);
  return groups.ok ? ok(groups.value.permission) : groups;
}

/** `-c` pairs, each `-c` and its value as two argv elements. */
function overrides(settings: ReadonlyArray<readonly [string, TomlValue]>): Result<string[], string> {
  const argv: string[] = [];
  for (const [key, value] of settings) {
    const text = override(key, value);
    if (!text.ok) return text;
    argv.push("-c", text.value);
  }
  return ok(argv);
}

/** Every path closed to commands, each once: `~/`-relative or absolute. */
function closedPaths(options: CodexArgsOptions): Result<string[], string> {
  const tokamaHome = options.tokamaHome ?? DEFAULT_TOKAMA_HOME;
  const paths = [...CREDENTIAL_PATHS, tokamaHome, ...(options.closedDirs ?? [])];
  const bad = paths.find((path) => !(isAbsolute(path) || path.startsWith("~/")));
  if (bad !== undefined) return err(`"${bad}" is not an absolute path`);
  return ok([...new Set(paths)]);
}

/** The first flag or setting of `argv` that Tokama never passes, or undefined. */
export function forbiddenIn(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    const flag = word.split("=")[0] ?? "";
    if (FORBIDDEN_FLAGS.includes(flag) || word.startsWith("--dangerously")) return flag;
    if (word === "-c" || word === "--config") {
      const key = (argv[i + 1] ?? "").split("=")[0] ?? "";
      if (FORBIDDEN_SETTINGS.test(key)) return key;
    }
  }
  return undefined;
}
