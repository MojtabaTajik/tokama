import { posixSh } from "./posix.js";
import type { SyntaxRefusalReason } from "./policy.js";

const REFUSAL_WORDS: Record<SyntaxRefusalReason, string> = {
  substitution: "command substitution ($(...) or backticks)",
  "ansi-c-quote": "$'...' quoting",
  redirect: "a redirect (>, <)",
  background: "a background &",
  subshell: "a subshell ( ... )",
  newline: "a line break",
  "unbalanced-quote": "an unclosed quote",
};

// Control characters, invisible and direction-changing characters, and line and paragraph breaks:
// a command with one can read as another command than the one that runs.
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Why a check isn't one simple command on one line of plain text, or undefined when it is. Parsed as the command policy parses checks. */
export function simpleCommandProblem(command: string): string | undefined {
  const split = posixSh.split(command);
  if (!split.ok) return `can't use ${REFUSAL_WORDS[split.error.reason]}`;
  if (split.value.length !== 1) return "must be one command, with no &&, ||, ; or |";
  if (split.value[0]!.words.length === 0) return "has no command words";
  if (NOT_PLAIN.test(command)) return "has a control, invisible or line-break character";
  return undefined;
}
