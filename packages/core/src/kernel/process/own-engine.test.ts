import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDescribe, readEngineLock, stopOwnEngine, verifyOwnEngine, type EngineProcesses, type OwnEngine } from "./own-engine.js";

const DIR = "/home/dev/.tokama/run";
const END = `/engine/dist/main.js --dir ${DIR}`;
const ENGINE_LINE = `/usr/bin/node /src/tokama/apps/engine/dist/main.js --dir ${DIR}`;
const LOCK_WRITTEN = Date.UTC(2026, 10, 25, 9, 0, 10);
const STARTED = Date.UTC(2026, 10, 25, 9, 0, 9);
const PID = 4821;
const SELF = 900;

let dir: string;
let engine: OwnEngine;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tk-own-"));
  engine = { lockPath: join(dir, "engine.lock"), commandEnd: END, otherLocks: [join(dir, "home.lock")] };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLock(path: string, content: string, at = LOCK_WRITTEN): void {
  writeFileSync(path, content);
  utimesSync(path, at / 1000, at / 1000);
}

interface FakeProcess {
  startedAt: number;
  command: string;
  /** Signals it survives. */
  ignores?: ("SIGTERM" | "SIGKILL")[];
}

/** A process table in memory. A signalled process ends unless it ignores the signal; an ended engine leaves its lock behind. */
function fakeProcesses(processes: Record<number, FakeProcess>) {
  const live = new Map(Object.entries(processes).map(([pid, p]) => [Number(pid), p]));
  const signals: [number, string][] = [];
  const table: EngineProcesses = {
    describe: async (pid) => {
      const p = live.get(pid);
      return p === undefined ? undefined : { startedAt: p.startedAt, command: p.command };
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (!live.get(pid)?.ignores?.includes(signal)) live.delete(pid);
    },
  };
  return { table, signals, live };
}

const fast = { stepMs: 30, pollMs: 5, selfPid: SELF };

describe("readEngineLock", () => {
  it("reads the pid, the engine id and the write time", () => {
    writeLock(engine.lockPath, `${PID} e-1\n`);
    expect(readEngineLock(engine.lockPath)).toEqual({ pid: PID, engineId: "e-1", writtenAt: LOCK_WRITTEN });
  });

  it("is undefined for a missing or malformed lock", () => {
    expect(readEngineLock(engine.lockPath)).toBeUndefined();
    writeLock(engine.lockPath, "not a lock\n");
    expect(readEngineLock(engine.lockPath)).toBeUndefined();
    writeLock(engine.lockPath, `-5 e-1\n`);
    expect(readEngineLock(engine.lockPath)).toBeUndefined();
  });
});

describe("verifyOwnEngine", () => {
  it("accepts a live pid whose command line is this app's engine for this dir, started before the lock was written", async () => {
    writeLock(engine.lockPath, `${PID} e-1\n`);
    const { table } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE } });
    expect(await verifyOwnEngine(engine, table, SELF)).toEqual({ kind: "verified", lock: { pid: PID, engineId: "e-1", writtenAt: LOCK_WRITTEN }, startedAt: STARTED });
  });

  it("accepts the engine started from another checkout of the app, for the same dir", async () => {
    writeLock(engine.lockPath, `${PID} e-1\n`);
    const { table } = fakeProcesses({ [PID]: { startedAt: STARTED, command: `/opt/node/bin/node /work/other/apps/engine/dist/main.js --dir ${DIR}` } });
    expect((await verifyOwnEngine(engine, table, SELF)).kind).toBe("verified");
  });

  it.each([
    ["the sample engine of this dir", `/usr/bin/node /src/apps/engine/dist/main.js --dir ${DIR}/sample --sample`],
    ["an engine for another dir", "/usr/bin/node /src/apps/engine/dist/main.js --dir /home/dev/.tokama/other"],
    ["an engine for a dir that ends like this one", `/usr/bin/node /src/apps/engine/dist/main.js --dir /x${DIR}`],
    ["another program", "/usr/bin/vim notes.txt"],
    ["a program that names this dir but is no engine", `/usr/bin/tail --dir ${DIR}`],
  ])("refuses %s", async (_name, command) => {
    writeLock(engine.lockPath, `${PID} e-1\n`);
    const { table } = fakeProcesses({ [PID]: { startedAt: STARTED, command } });
    expect(await verifyOwnEngine(engine, table, SELF)).toEqual({ kind: "refused", reason: "not_engine", pid: PID });
  });

  it("refuses a pid that started after the lock was written: a reused pid", async () => {
    writeLock(engine.lockPath, `${PID} e-1\n`);
    const { table } = fakeProcesses({ [PID]: { startedAt: LOCK_WRITTEN + 60_000, command: ENGINE_LINE } });
    expect(await verifyOwnEngine(engine, table, SELF)).toEqual({ kind: "refused", reason: "pid_reused", pid: PID });
  });

  it("refuses a missing lock, a dead pid, pid 1 and its own pid", async () => {
    const { table } = fakeProcesses({ 1: { startedAt: STARTED, command: ENGINE_LINE }, [SELF]: { startedAt: STARTED, command: ENGINE_LINE } });
    expect(await verifyOwnEngine(engine, table, SELF)).toEqual({ kind: "refused", reason: "no_lock" });
    writeLock(engine.lockPath, `${PID} e-1\n`);
    expect(await verifyOwnEngine(engine, table, SELF)).toEqual({ kind: "refused", reason: "gone", pid: PID });
    writeLock(engine.lockPath, `1 e-1\n`);
    expect(await verifyOwnEngine(engine, table, SELF)).toEqual({ kind: "refused", reason: "unsafe", pid: 1 });
    writeLock(engine.lockPath, `${SELF} e-1\n`);
    expect(await verifyOwnEngine(engine, table, SELF)).toEqual({ kind: "refused", reason: "unsafe", pid: SELF });
  });

  it("refuses a command end that is not whole path segments", async () => {
    writeLock(engine.lockPath, `${PID} e-1\n`);
    const { table } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE } });
    expect((await verifyOwnEngine({ ...engine, commandEnd: `main.js --dir ${DIR}` }, table, SELF)).kind).toBe("refused");
  });
});

describe("stopOwnEngine", () => {
  beforeEach(() => writeLock(engine.lockPath, `${PID} e-1\n`));

  it("stops it with the shutdown request alone when the engine accepts it", async () => {
    const { table, signals, live } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE } });
    const requestShutdown = vi.fn(async () => {
      live.delete(PID);
      return true;
    });
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown, ...fast })).toMatchObject({ kind: "stopped", by: "shutdown" });
    expect(requestShutdown).toHaveBeenCalledOnce();
    expect(signals).toEqual([]);
  });

  it("sends SIGTERM at once to an engine that refuses the request (one from before it)", async () => {
    const { table, signals } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE } });
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown: async () => false, ...fast, stepMs: 60_000 })).toMatchObject({ kind: "stopped", by: "sigterm" });
    expect(signals).toEqual([[PID, "SIGTERM"]]);
  });

  it("escalates to SIGTERM, then SIGKILL, for an engine that ignores the request and SIGTERM", async () => {
    const { table, signals } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE, ignores: ["SIGTERM"] } });
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown: async () => true, ...fast })).toMatchObject({ kind: "stopped", by: "sigkill" });
    expect(signals).toEqual([
      [PID, "SIGTERM"],
      [PID, "SIGKILL"],
    ]);
  });

  it("reports an engine that survives SIGKILL", async () => {
    const { table } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE, ignores: ["SIGTERM", "SIGKILL"] } });
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown: async () => true, ...fast })).toMatchObject({ kind: "still_running", lock: { pid: PID } });
  });

  it.each([
    ["a reused pid", { startedAt: LOCK_WRITTEN + 60_000, command: ENGINE_LINE }],
    ["another program", { startedAt: STARTED, command: "/usr/bin/vim notes.txt" }],
    ["the sample engine", { startedAt: STARTED, command: `/usr/bin/node /src/apps/engine/dist/main.js --dir ${DIR}/sample --sample` }],
  ])("sends nothing at all to %s", async (_name, process) => {
    const { table, signals } = fakeProcesses({ [PID]: process });
    const requestShutdown = vi.fn(async () => true);
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown, ...fast })).toMatchObject({ kind: "refused" });
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it("does not signal a pid that another process took while the engine stopped", async () => {
    const { table, signals, live } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE } });
    // The engine accepts but takes long; meanwhile it ends, and a new process gets its pid.
    const requestShutdown = async () => {
      setTimeout(() => live.set(PID, { startedAt: LOCK_WRITTEN + 5_000, command: ENGINE_LINE }), 1);
      return true;
    };
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown, ...fast })).toMatchObject({ kind: "stopped", by: "shutdown" });
    expect(signals).toEqual([]);
  });

  it("sends nothing more once the lock names another engine: someone else replaced it", async () => {
    const { table, signals } = fakeProcesses({
      [PID]: { startedAt: STARTED, command: ENGINE_LINE, ignores: ["SIGTERM", "SIGKILL"] },
      5000: { startedAt: LOCK_WRITTEN + 20_000, command: ENGINE_LINE },
    });
    const requestShutdown = async () => {
      setTimeout(() => writeLock(engine.lockPath, "5000 e-2\n", LOCK_WRITTEN + 21_000), 1);
      return true;
    };
    // The old pid still runs, but no lock names it any more: it let go, so it counts as stopped.
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown, ...fast })).toMatchObject({ kind: "stopped", by: "shutdown" });
    expect(signals).toEqual([]);
  });

  it("counts the engine as stopped once neither lock names it, while its process ends", async () => {
    writeLock(join(dir, "home.lock"), `${PID} e-1 /run/engine.sock\n`);
    const { table, signals } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE, ignores: ["SIGTERM", "SIGKILL"] } });
    const requestShutdown = async () => {
      setTimeout(() => {
        unlinkSync(engine.lockPath);
        unlinkSync(join(dir, "home.lock"));
      }, 1);
      return true;
    };
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown, ...fast })).toMatchObject({ kind: "stopped", by: "shutdown" });
    expect(signals).toEqual([]);
  });
});

describe("stopOwnEngine when things go wrong", () => {
  beforeEach(() => writeLock(engine.lockPath, `${PID} e-1\n`));

  it("sends nothing when the process list cannot be read", async () => {
    const signals: string[] = [];
    const table: EngineProcesses = { describe: () => Promise.reject(new Error("ps timed out")), signal: (_pid, signal) => void signals.push(signal) };
    const requestShutdown = vi.fn(async () => true);
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown, ...fast })).toEqual({ kind: "refused", reason: "unreadable", pid: PID });
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it("goes on to the next step when a signal fails, and does not throw", async () => {
    const { table, live } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE } });
    const failing: EngineProcesses = {
      describe: table.describe,
      signal: (pid, signal) => {
        if (signal === "SIGTERM") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        live.delete(pid);
      },
    };
    expect(await stopOwnEngine(engine, { processes: failing, requestShutdown: async () => false, ...fast })).toMatchObject({ kind: "stopped", by: "sigkill" });
  });
});

describe("stopOwnEngine with an expected engine", () => {
  it("sends nothing when the lock names another engine than the one the caller found", async () => {
    writeLock(engine.lockPath, `${PID} e-new\n`);
    const { table, signals } = fakeProcesses({ [PID]: { startedAt: STARTED, command: ENGINE_LINE } });
    const requestShutdown = vi.fn(async () => true);
    expect(await stopOwnEngine(engine, { processes: table, requestShutdown, expectedEngineId: "e-old", ...fast })).toEqual({ kind: "replaced" });
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });
});

describe("parseDescribe", () => {
  it("reads the start time and the whole command line, spaces included", () => {
    expect(parseDescribe("Wed Nov 25 09:00:09 2026     /usr/bin/node /My Code/apps/engine/dist/main.js --dir /tmp/a b\n")).toEqual({
      startedAt: STARTED,
      command: "/usr/bin/node /My Code/apps/engine/dist/main.js --dir /tmp/a b",
    });
  });

  it("is undefined for empty or unreadable output", () => {
    expect(parseDescribe("")).toBeUndefined();
    expect(parseDescribe("garbage\n")).toBeUndefined();
    expect(parseDescribe("Wed Nov 25 09:00:09 2026\n")).toBeUndefined();
  });
});
