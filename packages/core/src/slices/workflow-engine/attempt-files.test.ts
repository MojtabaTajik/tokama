import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptRecord } from "../../kernel/schemas/index.js";
import { attemptChecks, attemptLog, toolLine } from "./attempt-files.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tk-attempt-")));
  mkdirSync(join(dir, "attempts", "build-1"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const files = () => ({ path: (name: string) => join(dir, "attempts", "build-1", name), itemPath: (rel: string) => join(dir, ...rel.split("/")) });
const save = (name: string, text: string) => writeFileSync(files().path(name), text);
const HOST = "host_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const process = (role: "agent" | "check", pid: number) => ({ role, pid, startedAt: 1, bootTime: 1, hostId: HOST }) as AttemptRecord["processes"][number];

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({ attempt: 1, startedAt: 1, processes: [], checks: [], ...over });
const PLANNED = { commands: ["pnpm test", "pnpm lint", "pnpm build"], setupRuns: true };

describe("attemptChecks", () => {
  it("lists the recorded checks with the end of their output; a check recorded before durations has none", async () => {
    save("check-1.log", "\u001b[31mFAIL\u001b[39m one\n2 failing\n\n");
    const ended = attempt({
      endedAt: 9,
      result: "failed",
      checks: [
        { command: "pnpm test", exitCode: 1, passed: false, outputFile: "attempts/build-1/check-1.log", durationMs: 1500, at: 5 },
        { command: "pnpm lint", exitCode: 0, passed: true, at: 6 },
      ],
    });
    expect(await attemptChecks(ended, files(), PLANNED)).toEqual({
      attempt: 1,
      checks: [
        { command: "pnpm test", state: "failed", exitCode: 1, durationMs: 1500, summary: "2 failing", output: { text: "FAIL one\n2 failing\n", truncated: false, totalBytes: 30, totalLines: 3 } },
        { command: "pnpm lint", state: "passed", exitCode: 0, durationMs: null, summary: "", output: null },
      ],
    });
  });

  it("while the agent works, every planned check waits", async () => {
    const running = attempt({ processes: [process("agent", 10)] });
    expect((await attemptChecks(running, files(), PLANNED)).checks.map((c) => [c.command, c.state])).toEqual([
      ["pnpm test", "waiting"],
      ["pnpm lint", "waiting"],
      ["pnpm build", "waiting"],
    ]);
  });

  it("while setup runs, the checks still wait; then the check whose process started runs, with its output so far", async () => {
    const inSetup = attempt({ processes: [process("agent", 10), process("check", 11)] });
    expect((await attemptChecks(inSetup, files(), PLANNED)).checks.map((c) => c.state)).toEqual(["waiting", "waiting", "waiting"]);
    save("check-2.log", "linting 3 of 9\n");
    const inLint = attempt({
      processes: [process("agent", 10), process("check", 11), process("check", 12), process("check", 13)],
      checks: [{ command: "pnpm test", exitCode: 0, passed: true, at: 5 }],
    });
    expect((await attemptChecks(inLint, files(), PLANNED)).checks).toEqual([
      expect.objectContaining({ command: "pnpm test", state: "passed" }),
      { command: "pnpm lint", state: "running", exitCode: null, durationMs: null, summary: "linting 3 of 9", output: { text: "linting 3 of 9", truncated: false, totalBytes: 15, totalLines: 1 } },
      { command: "pnpm build", state: "waiting", exitCode: null, durationMs: null, summary: "", output: null },
    ]);
  });

  it("an ended attempt lists only what it recorded", async () => {
    expect(await attemptChecks(attempt({ endedAt: 9, result: "run_failed" }), files(), PLANNED)).toEqual({ attempt: 1, checks: [] });
  });
});

describe("attemptLog", () => {
  it("serves the transcript's end and, once the attempt ended, the final message", async () => {
    save("transcript.txt", "I'll fix it.\n\n→ Edit src/a.ts\n\nDone.");
    save("agent.txt", "Done.");
    expect(await attemptLog(attempt({ endedAt: 9, result: "passed" }), files())).toEqual({
      attempt: 1,
      transcript: { text: "I'll fix it.\n\n→ Edit src/a.ts\n\nDone.", truncated: false, totalBytes: 38, totalLines: 5 },
      final: { text: "Done.", truncated: false },
    });
    // A running attempt has no final message yet, even if an older file is there.
    expect((await attemptLog(attempt(), files())).final).toBeNull();
  });

  it("says a transcript that was not saved is missing, without failing", async () => {
    expect(await attemptLog(attempt({ endedAt: 9, result: "failed" }), files())).toEqual({ attempt: 1, transcript: null, final: null });
  });
});

describe("toolLine", () => {
  const call = (name: string, input: Record<string, string | number>) => ({ type: "tool_call" as const, id: "1", name, kind: "other" as const, input });

  it("names the tool and what it works on, relative to the worktree", () => {
    expect(toolLine(call("Read", { file_path: "/home/me/orders-api/.tokama/wt/x/src/list.ts" }), "/home/me/orders-api/.tokama/wt/x")).toBe("→ Read src/list.ts");
    expect(toolLine(call("Bash", { command: "pnpm test" }), "/wt")).toBe("→ Bash pnpm test");
    expect(toolLine(call("Glob", { limit: 3 }), "/wt")).toBe("→ Glob");
  });

  it("keeps it to one cleaned line of at most 300 characters", () => {
    expect(toolLine(call("Bash", { command: "echo a\nb\u001b[31m" }), "/wt")).toBe("→ Bash echo a b");
    const long = toolLine(call("Bash", { command: "x".repeat(500) }), "/wt");
    expect(long).toHaveLength(300);
    expect(long.endsWith("…")).toBe(true);
  });
});
