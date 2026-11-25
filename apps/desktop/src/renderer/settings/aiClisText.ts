// The words the AI CLIs page uses: a CLI's state as a symbol and a word, and an argument list as one
// line a person could type.
import type { AiCli, AiCliState } from "@tokama/core";

export interface StateWords {
  /** A different shape per kind, so the colour is never the only signal. */
  readonly symbol: string;
  readonly word: string;
  readonly tone: "pass" | "warn" | "fail" | "muted";
}

const STATES: Readonly<Record<AiCliState, StateWords>> = {
  ready: { symbol: "●", word: "Logged in", tone: "pass" },
  not_logged_in: { symbol: "○", word: "Not logged in", tone: "warn" },
  not_installed: { symbol: "✕", word: "Not found", tone: "fail" },
  no_answer: { symbol: "…", word: "Did not answer", tone: "warn" },
  not_checked: { symbol: "–", word: "Not checked", tone: "muted" },
};

export const stateWords = (cli: AiCli): StateWords => (cli.supported ? STATES[cli.state] : { symbol: "–", word: "Not supported yet", tone: "muted" });

const PLAIN = /^[\w@%+=:,./~*{}-]+$/;

/** The arguments as one line; a word with a space, a quote or a shell character is quoted. */
export const argLine = (words: readonly string[]): string => words.map((word) => (PLAIN.test(word) ? word : JSON.stringify(word))).join(" ");
