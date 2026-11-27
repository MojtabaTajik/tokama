import { rulePrefixes } from "../../../kernel/command-policy/index.js";
import { READ_ONLY, type AgentCallRequest } from "../../../kernel/ports/index.js";
import { err, ok, type Result } from "../../../kernel/result/index.js";

const READ_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Edit", "Write"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];
/** Tokama's own data (settings, item logs, the database). Agents never read or edit it. */
export const DEFAULT_TOKAMA_HOME = "~/.tokama";
// A rule word that could end the permission rule early or split the flag's list.
const UNSAFE_WORD = /[(),]/;

/**
 * The argv after the `claude` command for one headless call. The prompt goes to stdin as a
 * stream-json user message, so nothing positional follows the flags.
 *
 * - `--restricted`: ignores user, project and local settings (a repo's `.claude/settings.json`
 *   could add allow rules or hooks), keeps file tools inside the working directory, and refuses
 *   writes to git and settings files without a person's approval.
 * - `--permission-mode dontAsk`: anything not allowed below is denied; nobody is asked. One
 *   exception: once Bash is a tool, Claude Code also runs commands it judges read-only (`ls`,
 *   `whoami`, ...) without a rule.
 * - `--tools`: only the tools the limits allow exist in the session.
 * - `--strict-mcp-config` without `--mcp-config`: no MCP servers from the user's config.
 * - `--settings`: when the shell is on, a PreToolUse hook that denies every command the step's
 *   rules do not allow, read-only ones included (see hook.ts). `--restricted` still applies it.
 * - Single-value flags use `--flag=value`, so a value that starts with `-` is never read as a flag.
 */
export function buildArgs(request: AgentCallRequest, settingsPath?: string, tokamaHome?: string): Result<string[], string> {
  const groups = argGroups(request, settingsPath, tokamaHome);
  if (!groups.ok) return groups;
  const { headless, model, permission, instructions } = groups.value;
  return ok([...headless, ...model, ...permission, ...instructions]);
}

/** The argv of `buildArgs`, by what each flag is for. Flattened in this order, it is the argv. */
export interface ArgGroups {
  /** No terminal, and events Tokama can read. */
  readonly headless: string[];
  readonly model: string[];
  /** What the session may do: sandbox, tools, rules, settings. */
  readonly permission: string[];
  /** The agent's role. The step's prompt is not an argument: it goes to stdin. */
  readonly instructions: string[];
}

/**
 * `tokamaHome` is Tokama's folder, `~/.tokama` or an absolute path; the file tools may not touch it.
 */
export function argGroups(request: AgentCallRequest, settingsPath?: string, tokamaHome: string = DEFAULT_TOKAMA_HOME): Result<ArgGroups, string> {
  const limits = request.limits ?? READ_ONLY;
  if (request.model === "" || request.model.startsWith("-")) return err(`not a model name: "${request.model}"`);
  const prefixes = rulePrefixes(limits.commands);
  for (const words of prefixes) {
    if (words[0]?.startsWith("-") || words.some((word) => UNSAFE_WORD.test(word))) {
      return err(`command rule cannot be passed to Claude Code: "${words.join(" ")}"`);
    }
  }
  const commands = prefixes.map((words) => `Bash(${words.join(" ")}:*)`);
  const tools = [
    ...READ_TOOLS,
    ...(limits.edit ? EDIT_TOOLS : []),
    ...(commands.length > 0 ? ["Bash"] : []),
    ...(limits.web ? WEB_TOOLS : []),
  ];
  const allow = [...(limits.edit ? ["Edit(./**)"] : []), ...commands, ...(limits.web ? WEB_TOOLS : [])];
  const home = permissionPath(tokamaHome);
  const deny = [`Read(${home}/**)`, `Edit(${home}/**)`, ...(limits.web ? [] : WEB_TOOLS)];

  const permission = ["--restricted", "--permission-mode=dontAsk", "--strict-mcp-config", `--tools=${tools.join(",")}`];
  // The list flags take every following word up to the next flag.
  if (allow.length > 0) permission.push("--allowedTools", ...allow);
  permission.push("--disallowedTools", ...deny);
  if (settingsPath !== undefined) permission.push(`--settings=${settingsPath}`);
  // `--restricted` skips the settings files but not the person's CLAUDE.md, skills or plugin hooks; safe mode skips them all and keeps the login.
  if (request.plain === true) permission.push("--safe-mode");
  return ok({
    headless: ["-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose"],
    model: [`--model=${request.model}`],
    permission,
    instructions: request.role !== undefined && request.role !== "" ? [`--append-system-prompt=${request.role}`] : [],
  });
}

/** A path as a Read/Edit permission rule writes it: `~/x` stays, an absolute path takes the `//` prefix (a single `/` means project-relative). */
export const permissionPath = (path: string): string => (path.startsWith("/") ? `/${path}` : path);

/** True when the step allows any shell command, so the session has the Bash tool. */
export const usesShell = (request: AgentCallRequest): boolean => rulePrefixes(request.limits?.commands ?? []).length > 0;

/** The prompt as the one stream-json user message on stdin. */
export function userMessage(prompt: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`;
}
