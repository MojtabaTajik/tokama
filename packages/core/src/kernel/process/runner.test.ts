import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { posixTree } from "./posix.js";
import { createProcessRunner, type ProcessClock, type RunFinished, type RunResult } from "./runner.js";

// Process cases ported from ai-pipeline tests/test_claude_call.py (run_claude, run_claude_stream,
// env allowlist), plus the tree-kill cases the issue asks for. Fixtures are Node scripts run with
// `node -e`, so they behave the same on macOS and Linux. Every fixture ends itself after 20 s and
// every pid a test learns is killed in afterEach, so a failing test leaves nothing behind.

// Process tests get 20 s each: CI machines start Node slowly under load.
const SLOW = { timeout: 20_000 };
const LIFETIME = "setTimeout(() => {}, 20000);";
const node = (script: string): [string, ...string[]] => [process.execPath, "-e", script];

const tracked: number[] = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokama-process-"));
});
afterEach(() => {
  for (const pid of tracked.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid now belongs to another user's process, so ours is gone.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EPERM";
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Gone, not merely signalled: a zombie still answers kill(pid, 0) until it is reaped. */
const waitGone = (pid: number) => waitFor(() => !isAlive(pid), `pid ${pid} to exit`);

/** Timers that fire only when the test says so; `now` advances by 1 ms per call. */
function manualClock() {
  let time = 1_000;
  let nextId = 0;
  const timers = new Map<number, { ms: number; callback: () => void }>();
  const clock: ProcessClock = {
    now: () => time++,
    setTimeout: (callback, ms) => {
      timers.set(++nextId, { ms, callback });
      return nextId;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
  };
  const find = (ms: number) => [...timers].find(([, timer]) => timer.ms === ms);
  return {
    clock,
    pending: (ms: number) => find(ms) !== undefined,
    fire(ms: number) {
      const entry = find(ms);
      if (entry === undefined) throw new Error(`no pending ${ms} ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

function finished(result: RunResult): RunFinished {
  if (result.kind !== "finished") throw new Error(`expected a finished run, got ${JSON.stringify(result)}`);
  return result;
}

/** Collects lines and resolves `ready` on the first line that starts with `prefix`. */
function lineWaiter(prefix: string) {
  const lines: string[] = [];
  let resolveReady!: (line: string) => void;
  const ready = new Promise<string>((resolve) => (resolveReady = resolve));
  return {
    lines,
    ready,
    onLine(line: string) {
      lines.push(line);
      if (line.startsWith(prefix)) resolveReady(line);
    },
  };
}

/** A child that starts a `sleep` grandchild in its own group and prints both pids. */
const TREE = `
  const { spawn } = require("node:child_process");
  const grandchild = spawn("sleep", ["20"], { stdio: "ignore" });
  console.log("pids " + process.pid + " " + grandchild.pid);
  ${LIFETIME}`;

function pids(line: string): [number, number] {
  const [, child, grandchild] = line.split(" ").map(Number);
  if (child === undefined || grandchild === undefined) throw new Error(`bad pids line: ${line}`);
  tracked.push(child, grandchild);
  return [child, grandchild];
}

describe("process runner: exit and signals", SLOW, () => {
  it("reports the exit code", async () => {
    const result = finished(
      await createProcessRunner().run({ command: { argv: node("process.exit(3)") }, cwd: dir }),
    );
    expect(result).toMatchObject({ exitCode: 3, signal: null, timedOut: false, aborted: false });
    expect(result.pid).toBeGreaterThan(1);
  });

  it("reports the signal that ended the child", async () => {
    const result = finished(
      await createProcessRunner().run({ command: { argv: node("process.kill(process.pid, 'SIGKILL')") }, cwd: dir }),
    );
    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false });
  });

  it("measures durations with the injected clock", async () => {
    const { clock } = manualClock();
    const result = finished(await createProcessRunner({ clock }).run({ command: { argv: node("") }, cwd: dir }));
    expect(result.startedAt).toBe(1_000);
    expect(result.endedAt).toBeGreaterThan(result.startedAt);
    expect(result.durationMs).toBe(result.endedAt - result.startedAt);
  });

  it("returns spawn errors as values", async () => {
    const runner = createProcessRunner();
    expect(await runner.run({ command: { argv: ["tokama-no-such-command"] }, cwd: dir })).toMatchObject({
      kind: "not-started",
      reason: "spawn-error",
      code: "ENOENT",
    });
    expect(await runner.run({ command: { argv: node("") }, cwd: join(dir, "missing") })).toMatchObject({
      kind: "not-started",
      reason: "spawn-error",
    });
  });
});

describe("process runner: command and environment", SLOW, () => {
  it("passes argv without a shell", async () => {
    const out = lineWaiter("");
    await createProcessRunner().run({
      command: { argv: [...node("console.log(process.argv[1])"), "$HOME; echo injected"] },
      cwd: dir,
      stdout: out,
    });
    expect(out.lines).toEqual(["$HOME; echo injected"]);
  });

  it("runs a shell only when asked, in the given cwd", async () => {
    const out = lineWaiter("");
    const result = finished(
      await createProcessRunner().run({ command: { shell: "echo a && pwd && exit 4" }, cwd: dir, stdout: out }),
    );
    expect(out.lines[0]).toBe("a");
    // macOS temp dirs sit behind the /var -> /private/var link.
    expect(out.lines[1]?.endsWith(dir.split("/").pop() ?? "")).toBe(true);
    expect(result.exitCode).toBe(4);
  });

  it("drops parent variables outside the allowlist and adds explicit ones", async () => {
    // Ported from test_env_is_allowlisted, end to end through a real child.
    const out = lineWaiter("");
    await createProcessRunner({
      parentEnv: {
        PATH: process.env["PATH"],
        HOME: "/home/parent",
        LEAK_TOKEN: "secret",
        SSH_AUTH_SOCK: "/a",
        CLAUDECODE: "1",
        ANTHROPIC_API_KEY: "k",
      },
    }).run({
      command: { argv: node("console.log(JSON.stringify(process.env))") },
      cwd: dir,
      env: { HOME: "/home/override", EXTRA: "1" },
      stdout: out,
    });
    const env = JSON.parse(out.lines.join("")) as Record<string, string>;
    for (const name of ["LEAK_TOKEN", "SSH_AUTH_SOCK", "CLAUDECODE", "ANTHROPIC_API_KEY"]) {
      expect(env).not.toHaveProperty(name);
    }
    // Asserted per name, not as an exact set: macOS adds __CF_USER_TEXT_ENCODING to every process.
    expect(env).toMatchObject({ PATH: process.env["PATH"], HOME: "/home/override", EXTRA: "1" });
  });
});

describe("process runner: output streaming", SLOW, () => {
  it("streams stdout and stderr lines to callbacks and files", async () => {
    const out = lineWaiter("");
    const err = lineWaiter("");
    const stdoutFile = join(dir, "out.txt");
    const stderrFile = join(dir, "err.txt");
    await createProcessRunner().run({
      command: {
        argv: node(`
          process.stdout.write("one\\r\\ntw");
          setTimeout(() => { process.stdout.write("o\\nlast-without-break"); process.stderr.write("oops\\n"); }, 20);`),
      },
      cwd: dir,
      stdout: { file: stdoutFile, onLine: out.onLine },
      stderr: { file: stderrFile, onLine: err.onLine },
    });
    expect(out.lines).toEqual(["one", "two", "last-without-break"]);
    expect(err.lines).toEqual(["oops"]);
    expect(readFileSync(stdoutFile, "utf8")).toBe("one\r\ntwo\nlast-without-break");
    expect(readFileSync(stderrFile, "utf8")).toBe("oops\n");
  });

  it("decodes a UTF-8 character split across chunks", async () => {
    const out = lineWaiter("");
    await createProcessRunner().run({
      command: {
        argv: node(`
          const bytes = Buffer.from("گکو\\n");
          process.stdout.write(bytes.subarray(0, 1));
          setTimeout(() => process.stdout.write(bytes.subarray(1)), 20);`),
      },
      cwd: dir,
      stdout: out,
    });
    expect(out.lines).toEqual(["گکو"]);
  });

  it("keeps the transcript of a killed call", async () => {
    const file = join(dir, "out.txt");
    const controller = new AbortController();
    const result = finished(
      await createProcessRunner().run({
        command: { argv: node(`console.log("one"); console.log("two"); ${LIFETIME}`) },
        cwd: dir,
        signal: controller.signal,
        stdout: {
          file,
          onLine: (line) => {
            if (line === "two") controller.abort();
          },
        },
      }),
    );
    expect(result).toMatchObject({ aborted: true, signal: "SIGTERM", exitCode: null });
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("stops the child and rejects when a line callback throws", async () => {
    let pidLine = "";
    const run = createProcessRunner().run({
      command: { argv: node(TREE) },
      cwd: dir,
      stdout: {
        onLine: (line) => {
          pidLine = line;
          throw new Error("callback bug");
        },
      },
    });
    await expect(run).rejects.toThrow("callback bug");
    const [child, grandchild] = pids(pidLine);
    await waitGone(child);
    await waitGone(grandchild);
  });
});

describe("process runner: stop and timeout", SLOW, () => {
  it("does not start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const file = join(dir, "never.txt");
    expect(
      await createProcessRunner().run({
        command: { argv: node("") },
        cwd: dir,
        signal: controller.signal,
        stdout: { file },
      }),
    ).toMatchObject({ kind: "not-started", reason: "aborted" });
    expect(() => readFileSync(file)).toThrow();
  });

  it("times out and kills the whole tree", async () => {
    const timers = manualClock();
    const out = lineWaiter("pids ");
    const run = createProcessRunner({ clock: timers.clock }).run({
      command: { argv: node(TREE) },
      cwd: dir,
      timeoutMs: 60_000,
      stdout: out,
    });
    const [child, grandchild] = pids(await out.ready);
    timers.fire(60_000);
    const result = finished(await run);
    expect(result).toMatchObject({ timedOut: true, aborted: false, exitCode: null, signal: "SIGTERM" });
    await waitGone(child);
    await waitGone(grandchild);
  });

  it("times out on real timers with an empty transcript", async () => {
    // Ported from test_timeout_drains_with_bounded_wait and the timeout half of
    // test_stream_result_queued_at_deadline_counts_as_completed.
    const file = join(dir, "out.txt");
    const started = Date.now();
    const result = finished(
      await createProcessRunner().run({
        command: { argv: node(LIFETIME) },
        cwd: dir,
        timeoutMs: 300,
        stdout: { file },
      }),
    );
    expect(result.timedOut).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("aborts and kills the whole tree", async () => {
    const controller = new AbortController();
    const out = lineWaiter("pids ");
    const run = createProcessRunner().run({
      command: { argv: node(TREE) },
      cwd: dir,
      signal: controller.signal,
      stdout: out,
    });
    const [child, grandchild] = pids(await out.ready);
    controller.abort();
    expect(finished(await run)).toMatchObject({ aborted: true, timedOut: false, signal: "SIGTERM" });
    await waitGone(child);
    await waitGone(grandchild);
  });

  it("sends SIGKILL after the grace period when the child ignores SIGTERM", async () => {
    const timers = manualClock();
    const controller = new AbortController();
    const out = lineWaiter("ready");
    const run = createProcessRunner({ clock: timers.clock, killGraceMs: 5_000 }).run({
      command: { argv: node(`process.on("SIGTERM", () => {}); console.log("ready " + process.pid); ${LIFETIME}`) },
      cwd: dir,
      signal: controller.signal,
      stdout: out,
    });
    tracked.push(Number((await out.ready).split(" ")[1]));
    controller.abort();
    expect(timers.pending(5_000)).toBe(true);
    timers.fire(5_000);
    expect(finished(await run)).toMatchObject({ aborted: true, signal: "SIGKILL" });
  });

  it("kills a descendant that ignores SIGTERM once the leader exits", async () => {
    const controller = new AbortController();
    const out = lineWaiter("pids ");
    const run = createProcessRunner({ killGraceMs: 60_000 }).run({
      command: {
        argv: node(`
          const { spawn } = require("node:child_process");
          const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("up"); ${LIFETIME}'], { stdio: ["ignore", "pipe", "ignore"] });
          grandchild.stdout.once("data", () => console.log("pids " + process.pid + " " + grandchild.pid));
          ${LIFETIME}`),
      },
      cwd: dir,
      signal: controller.signal,
      stdout: out,
    });
    const [child, grandchild] = pids(await out.ready);
    controller.abort();
    expect(finished(await run)).toMatchObject({ aborted: true, signal: "SIGTERM" });
    await waitGone(child);
    await waitGone(grandchild);
  });
});

describe("process runner: exit while descendants run", SLOW, () => {
  it("returns at EOF without waiting for the drain timeout", async () => {
    // Ported from test_stream_eof_returns_without_drain_wait.
    const started = Date.now();
    const result = finished(
      await createProcessRunner({ drainMs: 10_000 }).run({ command: { argv: node("console.log('done')") }, cwd: dir }),
    );
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills background tools in the tree when the leader exits", async () => {
    // The grandchild holds stdout open; killing the group closes it, so no drain wait either.
    const out = lineWaiter("pid ");
    const started = Date.now();
    const result = finished(
      await createProcessRunner({ drainMs: 10_000 }).run({
        command: {
          argv: node(`
            const { spawn } = require("node:child_process");
            const grandchild = spawn("sleep", ["20"], { stdio: ["ignore", "inherit", "inherit"] });
            grandchild.unref();
            console.log("pid " + grandchild.pid);`),
        },
        cwd: dir,
        stdout: out,
      }),
    );
    const grandchild = Number((await out.ready).split(" ")[1]);
    tracked.push(grandchild);
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    await waitGone(grandchild);
  });

  it("stops waiting for output after the drain period when an escaped process holds the pipe", async () => {
    // Ported from the bounded-wait part of test_timeout_drains_with_bounded_wait. A descendant in
    // its own group is outside the tree; the run still ends, with the output read so far.
    const timers = manualClock();
    const out = lineWaiter("pid ");
    const run = createProcessRunner({ clock: timers.clock, drainMs: 3_000 }).run({
      command: {
        argv: node(`
          const { spawn } = require("node:child_process");
          const escaped = spawn("sleep", ["20"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
          escaped.unref();
          console.log("pid " + escaped.pid);`),
      },
      cwd: dir,
      stdout: out,
    });
    const escaped = Number((await out.ready).split(" ")[1]);
    tracked.push(escaped);
    await waitFor(() => timers.pending(3_000), "the drain timer");
    expect(isAlive(escaped)).toBe(true);
    timers.fire(3_000);
    expect(finished(await run)).toMatchObject({ exitCode: 0, timedOut: false });
    expect(out.lines).toEqual([`pid ${escaped}`]);
  });
});

describe("posixTree", SLOW, () => {
  it("refuses pids that would signal our own group or every process", () => {
    for (const pid of [0, 1, -5, Number.NaN]) {
      expect(() => posixTree.signalTree(pid, "SIGTERM")).toThrow(RangeError);
    }
  });

  it("ignores a tree that is already gone", async () => {
    const result = finished(await createProcessRunner().run({ command: { argv: node("") }, cwd: dir }));
    expect(() => posixTree.signalTree(result.pid, "SIGKILL")).not.toThrow();
  });
});
