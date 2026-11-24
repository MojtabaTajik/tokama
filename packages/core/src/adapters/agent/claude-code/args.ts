import { rulePrefixes } from "../../../kernel/command-policy/index.js";
import { READ_ONLY, type AgentCallRequest } from "../../../kernel/ports/index.js";
import { err, ok, type Result } from "../../../kernel/result/index.js";

const READ_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Edit", "Write"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];
// Tokama's own data (settings, item logs, the database). Agents never read or edit it.
const TOKAMA_HOME = "~/.tokama";
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
 * - Single-value flags use `--flag=value`, so a value that starts with `-` is never read as a flag.
 */
export function buildArgs(request: AgentCallRequest): Result<string[], string> {
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
  const deny = [`Read(${TOKAMA_HOME}/**)`, `Edit(${TOKAMA_HOME}/**)`, ...(limits.web ? [] : WEB_TOOLS)];

  const args = [
    "-p",
    "--input-format=stream-json",
    "--output-format=stream-json",
    "--verbose",
    `--model=${request.model}`,
    "--restricted",
    "--permission-mode=dontAsk",
    "--strict-mcp-config",
    `--tools=${tools.join(",")}`,
  ];
  // The list flags take every following word up to the next flag.
  if (allow.length > 0) args.push("--allowedTools", ...allow);
  args.push("--disallowedTools", ...deny);
  if (request.role !== undefined && request.role !== "") args.push(`--append-system-prompt=${request.role}`);
  return ok(args);
}

/** The prompt as the one stream-json user message on stdin. */
export function userMessage(prompt: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`;
}
