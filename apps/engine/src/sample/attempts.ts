// The sample items' saved check output and agent transcripts, served by attempt_checks and
// attempt_log. The raw text keeps colour codes and markup, as real logs do; the replies are
// cleaned and cut the way the real engine cleans and cuts saved files.
import {
  type AttemptChecksResult,
  type AttemptLogResult,
  MAX_CHECK_TAIL_BYTES,
  MAX_CHECK_TAIL_LINES,
  MAX_TRANSCRIPT_TAIL_BYTES,
  MAX_TRANSCRIPT_TAIL_LINES,
  terminalText,
} from "@tokama/core";
import { ITEM_IDS } from "./data.js";

interface SampleCheck {
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number;
  /** Absent like a check recorded before durations were. */
  readonly durationMs?: number;
  readonly output: string;
}

interface SampleLog {
  readonly transcript: string;
  readonly final: string;
}

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const RESET = "\u001b[39m";

const passingTests = (count: number) => Array.from({ length: count }, (_, i) => ` ${GREEN}✓${RESET} test/db/case-${String(i + 1).padStart(3, "0")}.test.ts (3 tests)`);

const dbFailure = (failing: number) =>
  [
    "> orders-api@4.2.0 test",
    "> vitest run",
    "",
    ...passingTests(12),
    "",
    ` ${RED}FAIL${RESET}  test/db/pool.test.ts > pool > closes idle clients on timeout`,
    "Error: Client was closed and is not queryable",
    " ❯ src/db/pool.ts:44:11",
    "     42|   const client = await pool.connect();",
    '     43|   // The fixture name is "<script>alert(1)</script>" on purpose: it must show as text.',
    "     44|   await client.query(SELECT_NOW);",
    "       |           ^",
    "",
    ` ${RED}FAIL${RESET}  test/db/pool.test.ts > pool > keeps a client a query still holds`,
    "AssertionError: expected 'closed' to be 'open'",
    "- Expected",
    "+ Received",
    "",
    "- open",
    "+ closed",
    "",
    " ❯ test/db/pool.test.ts:71:24",
    "     69|   const held = await pool.connect();",
    "     70|   await sleep(IDLE_TIMEOUT_MS + 10);",
    "     71|   expect(held.state).toBe('open');",
    "",
    ` Test Files  ${RED}1 failed${RESET} | 37 passed (38)`,
    `      Tests  ${RED}${failing} failed${RESET} | ${412 - failing} passed (412)`,
    "   Duration  1m 58s",
    `${RED}${failing} failing${RESET} · ${412 - failing} passed`,
  ].join("\n");

const LINT_OK = "> orders-api@4.2.0 lint\n> eslint .\n\nNo problems found.\n";

/** Each attempt's checks, by item and step index, oldest attempt first. */
export const sampleChecks: Readonly<Record<string, Readonly<Record<number, readonly (readonly SampleCheck[])[]>>>> = {
  [ITEM_IDS.failed]: {
    1: [
      [
        { command: "pnpm test", passed: false, exitCode: 1, output: dbFailure(6) },
        { command: "pnpm lint", passed: true, exitCode: 0, output: LINT_OK },
      ],
      [
        { command: "pnpm test", passed: false, exitCode: 1, durationMs: 118_000, output: dbFailure(4) },
        { command: "pnpm lint", passed: true, exitCode: 0, durationMs: 14_000, output: LINT_OK },
      ],
      [
        { command: "pnpm test", passed: false, exitCode: 1, durationMs: 117_000, output: dbFailure(4) },
        { command: "pnpm lint", passed: true, exitCode: 0, durationMs: 13_000, output: LINT_OK },
      ],
    ],
  },
};

const longTranscript = [
  "Attempt 3: the pool test still fails. I'll read every caller of pool.connect before I change it again.",
  ...Array.from({ length: 440 }, (_, i) => `→ Read src/db/callers/caller-${String(i + 1).padStart(3, "0")}.ts`),
  "Every caller releases its client. The idle timeout closes clients that a test still holds.",
  "→ Edit src/db/pool.ts",
  "→ Bash pnpm test test/db/pool.test.ts",
].join("\n");

/** Each attempt's transcript and final message, by item and step index, oldest attempt first. */
export const sampleLogs: Readonly<Record<string, Readonly<Record<number, readonly SampleLog[]>>>> = {
  [ITEM_IDS.failed]: {
    0: [
      {
        transcript: [
          "I'll upgrade pg to the next major version and fix what the new API breaks.",
          "→ Read package.json\n→ Read src/db/pool.ts\n→ Edit package.json\n→ Bash pnpm install",
          `The changelog says idle clients now close themselves. A note from the release, as written: ${RED}<script>alert(1)</script>${RESET}`,
          "→ Edit src/db/pool.ts\n→ Bash pnpm test test/db",
          "Upgraded pg and moved the pool to the new connect API.",
        ].join("\n\n"),
        final: "Upgraded pg and moved the pool to the new connect API.",
      },
      {
        transcript: "The pool test fails on idle clients. I'll keep clients that a query holds.\n\n→ Edit src/db/pool.ts\n→ Bash pnpm test test/db/pool.test.ts\n\nKept held clients out of the idle timeout.",
        final: "Kept held clients out of the idle timeout.",
      },
      { transcript: longTranscript, final: "Every caller releases its client. I could not find why the idle timeout still closes a held client." },
    ],
  },
};

/** The end of a text as the real engine reads it from a file: the last lines within both caps. */
function tailOf(raw: string, maxLines: number, maxBytes: number) {
  const all = raw.split("\n");
  if (all.at(-1) === "") all.pop();
  let lines = all.slice(-maxLines);
  while (lines.length > 0 && Buffer.byteLength(lines.join("\n")) > maxBytes) lines = lines.slice(1);
  return { text: terminalText(lines.join("\n")), truncated: lines.length < all.length, totalBytes: Buffer.byteLength(raw), totalLines: all.length };
}

export function checksReply(attempt: number, checks: readonly SampleCheck[]): AttemptChecksResult {
  return {
    attempt,
    checks: checks.map((check) => {
      const output = tailOf(check.output, MAX_CHECK_TAIL_LINES, MAX_CHECK_TAIL_BYTES);
      return {
        command: check.command,
        state: check.passed ? "passed" : "failed",
        exitCode: check.exitCode,
        durationMs: check.durationMs ?? null,
        summary: output.text.split("\n").findLast((line: string) => line.trim() !== "")?.trim() ?? "",
        output,
      };
    }),
  };
}

export function logReply(attempt: number, log: SampleLog): AttemptLogResult {
  return { attempt, transcript: tailOf(log.transcript, MAX_TRANSCRIPT_TAIL_LINES, MAX_TRANSCRIPT_TAIL_BYTES), final: { text: terminalText(log.final), truncated: false } };
}
