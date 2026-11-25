// The words the AI CLIs page uses: a CLI's state as a symbol and a word, and an argument list as one
// line a person could type.
import type { AiCli, AiCliState } from "@tokama/core";
import { type Mark, markOf } from "../ui/status.js";

/** A different shape per kind, so the colour is never the only signal. */
export type StateWords = Mark;

const STATES: Readonly<Record<AiCliState, StateWords>> = {
  ready: markOf("ready", "Logged in"),
  not_logged_in: markOf("logged_out", "Not logged in"),
  not_installed: markOf("failed", "Not found"),
  no_answer: markOf("no_answer", "Did not answer"),
  not_checked: markOf("unknown", "Not checked"),
};

export const stateWords = (cli: AiCli): StateWords => (cli.supported ? STATES[cli.state] : markOf("unknown", "Not supported yet"));

const PLAIN = /^[\w@%+=:,./~*{}-]+$/;

/** The arguments as one line; a word with a space, a quote or a shell character is quoted. */
export const argLine = (words: readonly string[]): string => words.map((word) => (PLAIN.test(word) ? word : JSON.stringify(word))).join(" ");
