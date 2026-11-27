import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { posixEngineProcesses, readEngineLock } from "./own-engine.js";

const PID = 4821;
const SOCKET = "/home/dev/.tokama/run/s-1a2b3c4d.sock";

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tk-own-"));
  lockPath = join(dir, "engine.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLock(path: string, content: string, mode = 0o600): void {
  writeFileSync(path, content);
  chmodSync(path, mode);
}

describe("readEngineLock", () => {
  it("reads the pid, the engine id, the socket and the whole text", () => {
    writeLock(lockPath, `${PID} e-1 ${SOCKET}\n`);
    expect(readEngineLock(lockPath)).toEqual({ pid: PID, engineId: "e-1", socketPath: SOCKET, text: `${PID} e-1 ${SOCKET}` });
  });

  it("keeps a socket path with spaces in it", () => {
    const spaced = "/Users/dev/My Folder/.tokama/run/s-1a2b3c4d.sock";
    writeLock(lockPath, `${PID} e-1 ${spaced}\n`);
    expect(readEngineLock(lockPath)?.socketPath).toBe(spaced);
  });

  it("is undefined for a missing or malformed lock", () => {
    expect(readEngineLock(lockPath)).toBeUndefined();
    for (const content of ["not a lock\n", `-5 e-1 ${SOCKET}\n`, `${PID} e-1\n`, `${PID} e-1 relative/s-1.sock\n`, `${PID} e-1 /run/engine.pid\n`, `${PID} e-1 /${"d".repeat(120)}/s-1a2b3c4d.sock\n`]) {
      writeLock(lockPath, content);
      expect(readEngineLock(lockPath), content).toBeUndefined();
    }
  });

  it("does not trust a lock that group or others can write", () => {
    writeLock(lockPath, `${PID} e-1 ${SOCKET}\n`, 0o620);
    expect(readEngineLock(lockPath)).toBeUndefined();
    chmodSync(lockPath, 0o602);
    expect(readEngineLock(lockPath)).toBeUndefined();
    chmodSync(lockPath, 0o644);
    expect(readEngineLock(lockPath)).toMatchObject({ pid: PID });
  });

  it("does not follow a symlink in place of the lock", () => {
    writeLock(join(dir, "real.lock"), `${PID} e-1 ${SOCKET}\n`);
    symlinkSync(join(dir, "real.lock"), lockPath);
    expect(readEngineLock(lockPath)).toBeUndefined();
  });
});

describe("posixEngineProcesses.signal", () => {
  it("refuses a pid that would reach a group or every process", () => {
    for (const pid of [0, 1, -1, 1.5]) expect(() => posixEngineProcesses.signal(pid, "SIGTERM")).toThrow(RangeError);
  });
});
