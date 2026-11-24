import { err, ok } from "../result/index.js";
import type { CommandPart, ShellGrammar, SyntaxRefusal } from "./policy.js";

// POSIX `sh` grammar for the command policy. A guardrail, not a full shell parser: it splits a
// command on `&&`, `||`, `;` and `|` outside quotes, and refuses everything else that could run
// code outside the allowlist. Ported from ai-pipeline's `split_check`; keep the branch order.
//
// Refused: any newline, quoted or escaped (so a `#` comment cannot hide a second line); `` ` ``
// or `$(` outside single quotes (also inside double quotes, where sh still substitutes);
// unquoted `$'` (ANSI-C quoting in bash, which is /bin/sh on macOS); unquoted `<`, `>` (except
// `2>&1`), `&`, `(`, `)`; unbalanced quotes. A backslash outside single quotes escapes the next
// character.

function split(command: string): ReturnType<ShellGrammar["split"]> {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let quoteStart = 0;
  let i = 0;
  const refuse = (reason: SyntaxRefusal["reason"], part: string) => err<SyntaxRefusal>({ reason, part, index: i });

  const newline = command.indexOf("\n");
  if (newline !== -1) return err({ reason: "newline", part: "\n", index: newline });

  while (i < command.length) {
    const ch = command.charAt(i);
    if (quote !== "'" && (ch === "`" || command.startsWith("$(", i))) {
      return refuse("substitution", ch === "`" ? "`" : "$(");
    }
    if (ch === "\\" && quote !== "'") {
      current += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      current += ch;
    } else if (command.startsWith("$'", i)) {
      return refuse("ansi-c-quote", "$'");
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      quoteStart = i;
      current += ch;
    } else if (command.startsWith("2>&1", i)) {
      current += "2>&1";
      i += 4;
      continue;
    } else if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      parts.push(current);
      current = "";
      i += 2;
      continue;
    } else if (ch === ";" || ch === "|") {
      parts.push(current);
      current = "";
    } else if (ch === "<" || ch === ">") {
      return refuse("redirect", ch);
    } else if (ch === "&") {
      return refuse("background", ch);
    } else if (ch === "(" || ch === ")") {
      return refuse("subshell", ch);
    } else {
      current += ch;
    }
    i += 1;
  }
  if (quote !== undefined) {
    return err({ reason: "unbalanced-quote", part: quote, index: quoteStart });
  }
  parts.push(current);
  return ok(parts.map((text): CommandPart => ({ text: text.trim(), words: words(text) })));
}

/**
 * The words of one part after quote removal, as sh sees them. Splits on space and tab only:
 * other whitespace (`\r`, NBSP, ...) stays inside the word, as it does in sh, so `node<NBSP>x`
 * is one word and never matches the rule `node`. Input is already balanced (checked by `split`).
 */
function words(text: string): string[] {
  const result: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
    } else if (quote === '"') {
      // Inside double quotes a backslash escapes only $ ` " \ and newline; otherwise it is literal.
      const next = text.charAt(i + 1);
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && next !== "" && '$`"\\\n'.includes(next)) word += text.charAt(++i);
      else word += ch;
    } else if (ch === " " || ch === "\t") {
      if (inWord) result.push(word);
      word = "";
      inWord = false;
    } else {
      inWord = true;
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "\\") word += text.charAt(++i);
      else word += ch;
    }
  }
  if (inWord) result.push(word);
  return result;
}

export const posixSh: ShellGrammar = { shell: "posix-sh", split };
