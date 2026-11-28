// What an attempt saved beside the item's log, read back for the attempt_checks and attempt_log
// queries: each check with the end of its output file, and the agent's transcript with its final
// message. Files are read with the fs-safe tail and head reads, so a huge log costs only its end;
// a missing or unreadable file reads as "not saved". Text is cleaned of terminal control
// sequences. Also how the run loop writes a tool call into the transcript.
import { readTextHead, readTextTail, type TextTail } from "../../kernel/fs-safe/index.js";
import {
  type AgentCallEvent,
  type AttemptCheck,
  type AttemptChecksResult,
  type AttemptLogResult,
  type AttemptRecord,
  MAX_ATTEMPT_CHECKS,
  MAX_CHECK_TAIL_BYTES,
  MAX_CHECK_TAIL_LINES,
  MAX_STEP_OUTPUT_BYTES,
  MAX_TRANSCRIPT_TAIL_BYTES,
  MAX_TRANSCRIPT_TAIL_LINES,
  terminalText,
} from "../../kernel/schemas/index.js";
import { cutText } from "../../kernel/text/index.js";
import { toolSubject } from "../execution/index.js";

/**
 * Counting lines reads the whole file, and a running attempt is read again every few seconds:
 * larger files get no line count.
 */
const COUNT_LINES_UP_TO = 4 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 200;
const MAX_TOOL_LINE_CHARS = 300;

/** What the replies need to find an attempt's files. */
export interface AttemptFiles {
  /** The full path of a file of this attempt, by name (`check-1.log`) or by its recorded item-relative path. */
  readonly path: (name: string) => string;
  /** The recorded file of a check is relative to the item's folder, not the attempt's. */
  readonly itemPath: (rel: string) => string;
}

/**
 * Each check of an attempt: those it recorded, then the planned ones that have not ended. While
 * the attempt runs, the one whose log file exists runs (the runner opens the file as the process
 * starts) and the others wait. Once it ended, the next one did not run to its end when its log
 * exists or the attempt's reason names it: refused, not started, stopped, or the engine stopped.
 */
export async function attemptChecks(attempt: AttemptRecord, files: AttemptFiles, planned: readonly string[] | undefined): Promise<AttemptChecksResult> {
  const recorded = attempt.checks.slice(0, MAX_ATTEMPT_CHECKS);
  const checks: AttemptCheck[] = [];
  for (const check of recorded) {
    const output = await checkTail(check.outputFile === undefined ? undefined : files.itemPath(check.outputFile));
    checks.push({
      command: check.command,
      state: check.passed ? "passed" : "failed",
      exitCode: check.exitCode,
      durationMs: check.durationMs ?? null,
      summary: summaryOf(output),
      output,
    });
  }
  const setup = attempt.setup === undefined ? {} : { setup: await setupLine(attempt.setup, files) };
  // A setup that did not pass: the checks were never started, however the attempt stands (it may wait for the engineer).
  if (attempt.setup?.passed === false) {
    for (const command of (planned ?? []).slice(recorded.length, MAX_ATTEMPT_CHECKS)) checks.push({ command, state: "not_run", exitCode: null, durationMs: null, summary: "", output: null });
    return { attempt: attempt.attempt, ...setup, checks };
  }
  const next = planned?.[recorded.length];
  if (planned === undefined || next === undefined || recorded.length >= MAX_ATTEMPT_CHECKS) return { attempt: attempt.attempt, ...setup, checks };
  const nextLog = files.path(`check-${recorded.length + 1}.log`);
  if (attempt.endedAt !== undefined) {
    const output = await checkTail(nextLog);
    const named = attempt.detail?.includes(`\`${next}\``) === true;
    if (output !== null || named) checks.push({ command: next, state: "not_run", exitCode: null, durationMs: null, summary: cut(attempt.detail ?? "") || summaryOf(output), output });
    return { attempt: attempt.attempt, ...setup, checks };
  }
  for (const [offset, command] of planned.slice(recorded.length, MAX_ATTEMPT_CHECKS).entries()) {
    const output = offset === 0 ? await checkTail(nextLog) : null;
    checks.push(output === null ? { command, state: "waiting", exitCode: null, durationMs: null, summary: "", output: null } : { command, state: "running", exitCode: null, durationMs: null, summary: summaryOf(output), output });
  }
  return { attempt: attempt.attempt, ...setup, checks };
}

/** The setup line of an attempt: the setup command's result and the end of its output, shaped like a check. */
async function setupLine(setup: NonNullable<AttemptRecord["setup"]>, files: AttemptFiles): Promise<AttemptCheck> {
  const output = await checkTail(setup.outputFile === undefined ? undefined : files.itemPath(setup.outputFile));
  return { command: setup.command, state: setup.passed ? "passed" : "failed", exitCode: setup.exitCode, durationMs: setup.durationMs ?? null, summary: summaryOf(output), output };
}

/** The end of the attempt's transcript and the agent's final message. */
export async function attemptLog(attempt: AttemptRecord, files: AttemptFiles): Promise<AttemptLogResult> {
  const transcript = await tailOf(files.path("transcript.txt"), MAX_TRANSCRIPT_TAIL_BYTES, MAX_TRANSCRIPT_TAIL_LINES);
  const final = await readTextHead(files.path("agent.txt"), { maxBytes: MAX_STEP_OUTPUT_BYTES, replaceInvalid: true });
  return {
    attempt: attempt.attempt,
    transcript,
    // agent.txt is written when the agent's call ends, in a folder no other attempt uses.
    final: final.ok ? { text: terminalText(final.value.text), truncated: final.value.truncated } : null,
  };
}

/**
 * One transcript line for a tool call: `→ Read src/orders/list.ts`. A known field names what it
 * works on, else the first text field; the worktree's own path is left out, so paths read
 * relative to it.
 */
export function toolLine(event: Extract<AgentCallEvent, { type: "tool_call" }>, worktree: string): string {
  const subject = toolSubject(event.input);
  const relative = subject?.split(`${worktree}/`).join("").split(worktree).join(".");
  const line = terminalText(`→ ${event.name}${relative === undefined || relative === "" ? "" : ` ${relative}`}`).replace(/\s+/g, " ").trim();
  return cutText(line, MAX_TOOL_LINE_CHARS);
}

const checkTail = (path: string | undefined) => (path === undefined ? Promise.resolve(null) : tailOf(path, MAX_CHECK_TAIL_BYTES, MAX_CHECK_TAIL_LINES));

async function tailOf(path: string, maxBytes: number, maxLines: number): Promise<TextTail | null> {
  const read = await readTextTail(path, { maxBytes, maxLines, countLinesUpTo: COUNT_LINES_UP_TO });
  return read.ok ? { ...read.value, text: terminalText(read.value.text) } : null;
}

/** The last line with words in it, cut to fit. */
const summaryOf = (output: TextTail | null): string => cut(output?.text.split("\n").findLast((candidate) => candidate.trim() !== "")?.trim() ?? "");

const cut = (line: string): string => cutText(line, MAX_SUMMARY_CHARS);
