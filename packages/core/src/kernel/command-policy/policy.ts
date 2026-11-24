import type { Result } from "../result/index.js";

/** One simple command of a command line: its text and its words after quote removal. */
export interface CommandPart {
  readonly text: string;
  readonly words: readonly string[];
}

export type SyntaxRefusalReason = "substitution" | "redirect" | "background" | "subshell" | "newline" | "unbalanced-quote";

/** Shell syntax the policy refuses: the offending token and where it starts in the command. */
export interface SyntaxRefusal {
  readonly reason: SyntaxRefusalReason;
  readonly part: string;
  readonly index: number;
}

/** One shell's command-line syntax (POSIX `sh` now, PowerShell later). */
export interface ShellGrammar {
  readonly shell: string;
  /** Splits a command line into its parts, or refuses syntax that could escape the allowlist. */
  split(command: string): Result<readonly CommandPart[], SyntaxRefusal>;
}

export type CommandDecision =
  | { readonly allowed: true; readonly parts: readonly string[] }
  | { readonly allowed: false; readonly reason: SyntaxRefusalReason; readonly part: string; readonly index: number }
  | { readonly allowed: false; readonly reason: "empty-part" | "not-allowlisted"; readonly part: string };

/** Read-only helpers allowed in every part, so checks can trim their output (`... 2>&1 | tail -5`). */
export const PIPE_HELPERS: readonly string[] = ["head", "tail", "wc"];

/**
 * Decides whether a check or step command may run. Allowed only if every part (split on `&&`,
 * `||`, `;`, `|` outside quotes) starts with the words of a rule or of a PIPE_HELPERS command.
 * A rule is a command prefix as in `npm test:*` or `node:*`: the words before the first `:`.
 * Rules without words (`""`, `:*`) are ignored, never treated as "allow everything".
 * Never throws: bad input is refused with a reason and the offending part.
 */
export function checkCommand(command: string, rules: readonly string[], shell: ShellGrammar): CommandDecision {
  const split = shell.split(command);
  if (!split.ok) return { allowed: false, ...split.error };

  const prefixes = [...rules.map((rule) => rule.split(":")[0] ?? ""), ...PIPE_HELPERS]
    .map((prefix) => prefix.split(/[ \t]+/).filter((word) => word !== ""))
    .filter((words) => words.length > 0);

  for (const part of split.value) {
    if (part.words.length === 0) return { allowed: false, reason: "empty-part", part: part.text };
    const matches = prefixes.some((prefix) => prefix.every((word, i) => part.words[i] === word));
    if (!matches) return { allowed: false, reason: "not-allowlisted", part: part.text };
  }
  return { allowed: true, parts: split.value.map((part) => part.text) };
}
