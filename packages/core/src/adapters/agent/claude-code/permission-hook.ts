// The decision of the PreToolUse hook (hook.ts): Tokama's own command policy on every Bash call.
// It can only deny. Printing "allow" would override Claude Code's own checks, such as keeping
// file access inside the working directory, so a command the policy allows gets no reply and
// Claude Code's permission rules still decide.
import { z } from "zod";
import { checkCommand, posixSh } from "../../../kernel/command-policy/index.js";

const Rules = z.strictObject({ commands: z.array(z.string()) });
const HookInput = z.looseObject({
  tool_name: z.string(),
  tool_input: z.looseObject({ command: z.unknown().optional(), dangerouslyDisableSandbox: z.unknown().optional() }),
});

const deny = (reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/**
 * The hook's stdout for one tool call: a deny, or undefined for no objection. Throws on input it
 * cannot read; the hook then exits with code 2, which Claude Code treats as a deny too.
 */
export function hookReply(input: string, rules: unknown): string | undefined {
  const { commands } = Rules.parse(rules);
  const call = HookInput.parse(JSON.parse(input));
  if (call.tool_name !== "Bash") return undefined;
  // Any value but an absent or false one asks to run outside the sandbox: a third layer after the
  // sandbox settings and the deny rule.
  const leave = call.tool_input.dangerouslyDisableSandbox;
  if (leave !== undefined && leave !== false) return deny("Tokama: commands must run inside the sandbox.");
  const command = call.tool_input.command;
  if (typeof command !== "string") return deny("Tokama: the command is not text.");
  const decision = checkCommand(command, commands, posixSh);
  if (decision.allowed) return undefined;
  return deny(`Tokama: this step does not allow "${decision.part}" (${decision.reason}).`);
}

/** The exit code `hook.ts` ends with after it wrote its reply, or nothing. It is the only code the wrapper turns into success. */
export const HOOK_DONE = 42;

/**
 * Claude Code settings that run `hookArgv` before every Bash call. The shell lets the hook's own
 * stdout through and turns its exit code into 0 only when it is HOOK_DONE; any other code becomes
 * 2, which blocks the call on every Claude Code version. That covers a hook that cannot start
 * (127 for a missing binary, Node's 1 for a missing or broken script) and a script that is empty
 * or cut short, which would exit 0 and print nothing, the same as an allowed command. An old
 * wrapper with a new hook, or a new wrapper with an old hook, blocks every call.
 * `onFailure: "block"` also blocks on a timeout; without it Claude Code lets the call run unchecked.
 */
export function hookSettings(hookArgv: readonly string[]): unknown {
  const command = `${hookArgv.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ")}; [ $? -eq ${HOOK_DONE} ] || exit 2`;
  return { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, onFailure: "block" }] }] } };
}
