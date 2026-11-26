import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockWriterLive, parseDescribe, posixEngineProcesses, readEngineLock, type EngineProcesses } from "./own-engine.js";

const DIR = "/home/dev/.tokama/run";
const ENGINE_LINE = `/usr/bin/node /src/tokama/apps/engine/dist/main.js --dir ${DIR}`;
const LOCK_WRITTEN = Date.UTC(2026, 10, 25, 9, 0, 10);
const STARTED = Date.UTC(2026, 10, 25, 9, 0, 9);
const PID = 4821;

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tk-own-"));
  lockPath = join(dir, "engine.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLock(path: string, content: string, at = LOCK_WRITTEN): void {
  writeFileSync(path, content);
  utimesSync(path, at / 1000, at / 1000);
}

/** A process table in memory, for `lockWriterLive`. */
function fakeProcesses(processes: Record<number, { startedAt: number; command: string }>): EngineProcesses {
  const live = new Map(Object.entries(processes).map(([pid, p]) => [Number(pid), p]));
  return { describe: async (pid) => live.get(pid), signal: () => {} };
}

describe("readEngineLock", () => {
  it("reads the pid, the engine id and the write time", () => {
    writeLock(lockPath, `${PID} e-1\n`);
    expect(readEngineLock(lockPath)).toEqual({ pid: PID, engineId: "e-1", writtenAt: LOCK_WRITTEN });
  });

  it("is undefined for a missing or malformed lock", () => {
    expect(readEngineLock(lockPath)).toBeUndefined();
    writeLock(lockPath, "not a lock\n");
    expect(readEngineLock(lockPath)).toBeUndefined();
    writeLock(lockPath, `-5 e-1\n`);
    expect(readEngineLock(lockPath)).toBeUndefined();
  });
});

describe("lockWriterLive", () => {
  // pidAlive is real: this process stands in for a live writer.
  const lock = (pid: number | undefined, writtenAt = LOCK_WRITTEN) => ({ pid, fields: pid === undefined ? [] : [String(pid)], writtenAt });
  const startedAt = (at: number) => fakeProcesses({ [process.pid]: { startedAt: at, command: ENGINE_LINE } });

  it("is live for a writer that started before the lock was written, however long ago that was", async () => {
    expect(await lockWriterLive(lock(process.pid), startedAt(STARTED), LOCK_WRITTEN + 3_600_000)).toBe(true);
    // ps rounds start times to the second.
    expect(await lockWriterLive(lock(process.pid), startedAt(LOCK_WRITTEN + 2_000), LOCK_WRITTEN)).toBe(true);
  });

  it("is not live for a pid that started after the lock was written (reused), or a dead pid", async () => {
    expect(await lockWriterLive(lock(process.pid), startedAt(LOCK_WRITTEN + 5_000), LOCK_WRITTEN)).toBe(false);
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(await lockWriterLive(lock(child.pid), startedAt(STARTED), LOCK_WRITTEN)).toBe(false);
  });

  it("is live when the start time cannot be read", async () => {
    const unreadable: EngineProcesses = { describe: () => Promise.reject(new Error("ps failed")), signal: () => {} };
    expect(await lockWriterLive(lock(process.pid), unreadable, LOCK_WRITTEN)).toBe(true);
  });

  it("is live for a lock with no pid yet only for a short grace", async () => {
    const table = fakeProcesses({});
    expect(await lockWriterLive(lock(undefined), table, LOCK_WRITTEN + 5_000)).toBe(true);
    expect(await lockWriterLive(lock(undefined), table, LOCK_WRITTEN + 10_000)).toBe(false);
  });
});

describe("posixEngineProcesses.signal", () => {
  it("refuses a pid that would reach a group or every process", () => {
    for (const pid of [0, 1, -1, 1.5]) expect(() => posixEngineProcesses.signal(pid, "SIGTERM")).toThrow(RangeError);
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
