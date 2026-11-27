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

/** Why a check isn't one simple command, or undefined when it is. Parsed as the command policy parses checks. */
export function simpleCommandProblem(command: string): string | undefined {
  const split = posixSh.split(command);
  if (!split.ok) return `can't use ${REFUSAL_WORDS[split.error.reason]}`;
  if (split.value.length !== 1) return "must be one command, with no &&, ||, ; or |";
  if (split.value[0]!.words.length === 0) return "has no command words";
  return undefined;
}
