// The pure parts of the checks helpers in the repo dialog: the lines of the Checks field, the
// quick one-command check the dialog makes before the engine's own, the words of the disclosure
// line and of a failed suggestion, and what the results of a Try checks run say.
import type { CheckTrial, HelperSummary } from "@tokama/core";
import { backendOf } from "../brand/backends/index.js";
import { formatDuration } from "../format/duration.js";

/** The most checks a repo has and one Try checks run takes. */
export const MAX_CHECKS = 20;

export const RULE_TEXT = "One command only: no &&, | or redirects. Put the second command on its own line.";

/** The non-empty lines of the Checks field, trimmed. */
export function checkLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Whether a command is plainly more than one simple command: an `&`, `|`, `;`, redirect, backtick
 * or `$(` outside quotes. A quick check for the edit field and the Try checks button; the engine
 * checks every command again with the real parser and its answer is shown as it comes.
 */
export function breaksRule(command: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') i++;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "\\") i++;
    else if ("&|;<>`".includes(char) || (char === "$" && command[i + 1] === "(")) return true;
  }
  return false;
}

/** Why Try checks is off for these lines and the setup command, naming the first line that breaks the rule; undefined when it can run. */
export function tryProblem(lines: readonly string[], setup = ""): string | undefined {
  if (setup !== "" && breaksRule(setup)) return `The setup command is more than one command. ${SETUP_RULE_TEXT}`;
  if (lines.length > MAX_CHECKS) return `Try checks runs at most ${MAX_CHECKS} checks.`;
  const bad = lines.findIndex(breaksRule);
  return bad === -1 ? undefined : `Line ${bad + 1} is more than one command. ${RULE_TEXT}`;
}

/** The AI tool and model a helper runs on, as one phrase: `Claude Code · haiku`. */
export function targetOf(summary: Pick<HelperSummary, "agent">): string | undefined {
  const agent = summary.agent;
  return agent === undefined ? undefined : `${backendOf(agent.cliId).name} · ${agent.model}`;
}

/** What the helper sends, as words: `file names and build files`. */
export function sendsOf(summary: Pick<HelperSummary, "sends">): string {
  const labels = summary.sends;
  if (labels.length === 0) return "nothing";
  return labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** The engine's words for "local-only mode is on"; the dialog gives that case its own line. */
export const LOCAL_ONLY_PREFIX = "Local-only mode";

export type Availability =
  | { readonly kind: "ready" }
  | { readonly kind: "local_only" }
  | { readonly kind: "no_cli" }
  | { readonly kind: "unavailable"; readonly problem: string };

/** Why Suggest with AI can or cannot run now, from the `helpers` query. `undefined` when the engine does not list the helper at all. */
export function availability(summary: HelperSummary | undefined): Availability | undefined {
  if (summary === undefined) return undefined;
  if (summary.available) return { kind: "ready" };
  const problem = summary.problem ?? "";
  if (problem.startsWith(LOCAL_ONLY_PREFIX)) return { kind: "local_only" };
  if (summary.agent === undefined && problem.startsWith("No AI CLI")) return { kind: "no_cli" };
  return { kind: "unavailable", problem };
}

export interface Failure {
  readonly head: string;
  /** The engine's own sentence, as text. */
  readonly message: string;
  /** What the line offers next. */
  readonly action: "retry" | "get-started";
}

const HEADS: Readonly<Record<string, string>> = {
  bad_answer: "No usable answer.",
  timeout: "No answer in time.",
  quota: "Limit reached.",
  rate_limit: "Limit reached.",
  auth: "Logged out.",
  too_large: "Too much to send.",
};

/** The line for a failed run, or a refused start. The code picks the head; any other code, a refused folder (`crash`) included, gets the plain head and the engine's sentence. */
export function failureOf(error: { readonly code: string; readonly message: string }): Failure {
  return { head: HEADS[error.code] ?? "Could not suggest checks.", message: error.message, action: error.code === "auth" ? "get-started" : "retry" };
}

/** How a check line of a trial reads: its word, and whether it passed, failed, or neither. */
export interface CheckLine {
  readonly word: string;
  readonly tone: "pass" | "fail" | "live" | "waiting" | "skipped";
  /** The line has output worth opening. */
  readonly hasOutput: boolean;
  readonly time: string | undefined;
}

export function lineOf(check: CheckTrial["checks"][number]): CheckLine {
  const time = check.durationMs === undefined ? undefined : formatDuration(check.durationMs, "fine");
  const output = check.outputTail !== undefined && check.outputTail.trim() !== "";
  switch (check.state) {
    case "passed":
      return { word: "Passed", tone: "pass", hasOutput: false, time };
    case "failed":
      return { word: check.exitCode === undefined ? "Could not start" : `Failed, exit ${check.exitCode}`, tone: "fail", hasOutput: output, time };
    case "timed_out":
      return { word: "Timed out", tone: "fail", hasOutput: output, time };
    case "running":
      return { word: "Running", tone: "live", hasOutput: false, time };
    case "waiting":
      return { word: "Waiting", tone: "waiting", hasOutput: false, time: undefined };
    case "skipped":
      return { word: "Not run", tone: "skipped", hasOutput: false, time: undefined };
  }
}

/** The setup line of a trial: its word, tone and time as a check line has them; Done, not Passed, for the good end. */
export function setupLineOf(setup: NonNullable<CheckTrial["setupResult"]>, now: number): CheckLine {
  const output = setup.outputTail !== undefined && setup.outputTail.trim() !== "";
  const time = setup.durationMs !== undefined ? formatDuration(setup.durationMs, "fine") : setup.state === "running" && setup.startedAt !== undefined ? formatDuration(Math.max(0, now - setup.startedAt), "fine") : undefined;
  switch (setup.state) {
    case "passed":
      return { word: "Done", tone: "pass", hasOutput: false, time };
    case "failed":
      return { word: setup.couldNotStart !== undefined || setup.exitCode === undefined ? "Could not start" : `Failed, exit ${setup.exitCode}`, tone: "fail", hasOutput: output, time };
    case "timed_out":
      return { word: "Timed out", tone: "fail", hasOutput: output, time };
    case "running":
      return { word: "Running", tone: "live", hasOutput: false, time };
    case "waiting":
      return { word: "Waiting", tone: "waiting", hasOutput: false, time: undefined };
    case "skipped":
      return { word: "Not run", tone: "skipped", hasOutput: false, time: undefined };
  }
}

/** The sentence under a setup command that was not found: what runs it differs from the user's terminal. */
export const couldNotStartText = (word: string): string => `${word} was not found. Tokama runs commands with the PATH of its background service, which can differ from your terminal.`;

/** The setup ended without passing: it failed, timed out or could not start. */
export const setupFailed = (trial: CheckTrial): boolean => trial.setupResult?.state === "failed" || trial.setupResult?.state === "timed_out";

/** The checks a setup that did not pass left unstarted. */
export const checksNotRun = (trial: CheckTrial): number => trial.checks.filter((check) => check.state === "skipped").length;

const countChecks = (count: number) => `${count} ${count === 1 ? "check" : "checks"}`;

/** The header of a finished run: `✓ 3 checks passed`, `✓ Setup and 3 checks passed`, `✕ Setup failed · 3 checks not run`, `■ Stopped`. */
export function summaryOf(trial: CheckTrial): { readonly tone: "pass" | "fail" | "stopped"; readonly text: string } {
  const total = trial.checks.length;
  const failed = trial.checks.filter((check) => check.state === "failed" || check.state === "timed_out").length;
  if (trial.state === "cancelled") return { tone: "stopped", text: "Stopped" };
  if (setupFailed(trial)) {
    const what = trial.setupResult?.state === "timed_out" ? "Setup timed out" : trial.setupResult?.couldNotStart !== undefined ? "Setup could not start" : "Setup failed";
    return { tone: "fail", text: total === 0 ? what : `${what} · ${countChecks(total)} not run` };
  }
  if (trial.state === "failed") return { tone: "fail", text: "The checks could not be tried" };
  if (failed > 0) return { tone: "fail", text: `${failed} of ${total} ${total === 1 ? "check" : "checks"} failed` };
  if (trial.setup !== undefined) return { tone: "pass", text: total === 0 ? "Setup done" : `Setup and ${countChecks(total)} passed` };
  return { tone: "pass", text: `${total} ${total === 1 ? "check" : "checks"} passed` };
}

/** Whether a finished trial ran without a setup command and a check did not pass: the run may have failed on a missing package. */
export const failedWithoutSetup = (trial: CheckTrial): boolean => trial.setup === undefined && trial.checks.some((check) => check.state === "failed" || check.state === "timed_out");

/** What Try checks is asked to run: the setup command, then the checks; its text is the one line of the field. */
export const trialTitle = (hasSetup: boolean, checks: number): string => (hasSetup ? (checks === 0 ? "Trying setup" : `Trying setup, then ${countChecks(checks)}`) : `Trying ${countChecks(checks)}`);

/** The Setup command field's text as one command: line breaks become spaces, ends trimmed. */
export const setupText = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

export const SETUP_RULE_TEXT = "One command only. Put the second command in Checks, or in a script that the setup command runs.";
