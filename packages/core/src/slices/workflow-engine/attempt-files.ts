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

/** Counting lines reads the whole file: larger files get no line count. */
const COUNT_LINES_UP_TO = 32 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 200;
const MAX_TOOL_LINE_CHARS = 300;

/** What the replies need to find an attempt's files. */
export interface AttemptFiles {
  /** The full path of a file of this attempt, by name (`check-1.log`) or by its recorded item-relative path. */
  readonly path: (name: string) => string;
  /** The recorded file of a check is relative to the item's folder, not the attempt's. */
  readonly itemPath: (rel: string) => string;
}

/** The planned checks of the attempt's step, for an attempt that runs. */
export interface PlannedChecks {
  readonly commands: readonly string[];
  /** The template's setup runs as a check process before the checks. */
  readonly setupRuns: boolean;
}

/**
 * Each check of an attempt: those it recorded, then, while it runs, the planned ones that have
 * not ended: the one whose process started runs, the others wait.
 */
export async function attemptChecks(attempt: AttemptRecord, files: AttemptFiles, planned: PlannedChecks | undefined): Promise<AttemptChecksResult> {
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
  if (attempt.endedAt === undefined && planned !== undefined) {
    const started = attempt.processes.filter((p) => p.role === "check").length - (planned.setupRuns ? 1 : 0);
    for (const [offset, command] of planned.commands.slice(recorded.length, MAX_ATTEMPT_CHECKS).entries()) {
      const index = recorded.length + offset;
      if (offset === 0 && started > recorded.length) {
        const output = await checkTail(files.path(`check-${index + 1}.log`));
        checks.push({ command, state: "running", exitCode: null, durationMs: null, summary: summaryOf(output), output });
      } else {
        checks.push({ command, state: "waiting", exitCode: null, durationMs: null, summary: "", output: null });
      }
    }
  }
  return { attempt: attempt.attempt, checks };
}

/** The end of the attempt's transcript and the agent's final message. */
export async function attemptLog(attempt: AttemptRecord, files: AttemptFiles): Promise<AttemptLogResult> {
  const transcript = await tailOf(files.path("transcript.txt"), MAX_TRANSCRIPT_TAIL_BYTES, MAX_TRANSCRIPT_TAIL_LINES);
  const final = await readTextHead(files.path("agent.txt"), { maxBytes: MAX_STEP_OUTPUT_BYTES, replaceInvalid: true });
  return {
    attempt: attempt.attempt,
    transcript,
    // agent.txt is written when the agent's call ends; until then there is no final message.
    final: final.ok && attempt.endedAt !== undefined ? { text: terminalText(final.value.text), truncated: final.value.truncated } : null,
  };
}

/**
 * One transcript line for a tool call: `→ Read src/orders/list.ts`. The first text field of its
 * input names what it works on; the worktree's own path is left out, so paths read relative to it.
 */
export function toolLine(event: Extract<AgentCallEvent, { type: "tool_call" }>, worktree: string): string {
  const subject = Object.values(event.input).find((value): value is string => typeof value === "string");
  const relative = subject?.split(`${worktree}/`).join("").split(worktree).join(".");
  const line = terminalText(`→ ${event.name}${relative === undefined || relative === "" ? "" : ` ${relative}`}`).replace(/\s+/g, " ").trim();
  return line.length > MAX_TOOL_LINE_CHARS ? `${line.slice(0, MAX_TOOL_LINE_CHARS - 1)}…` : line;
}

const checkTail = (path: string | undefined) => (path === undefined ? Promise.resolve(null) : tailOf(path, MAX_CHECK_TAIL_BYTES, MAX_CHECK_TAIL_LINES));

async function tailOf(path: string, maxBytes: number, maxLines: number): Promise<TextTail | null> {
  const read = await readTextTail(path, { maxBytes, maxLines, countLinesUpTo: COUNT_LINES_UP_TO });
  return read.ok ? { ...read.value, text: terminalText(read.value.text) } : null;
}

/** The last line with words in it, cut to fit. */
function summaryOf(output: TextTail | null): string {
  const line = output?.text.split("\n").findLast((candidate) => candidate.trim() !== "")?.trim() ?? "";
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…` : line;
}
