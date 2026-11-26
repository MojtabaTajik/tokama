import { mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pidAlive, readPidFile } from "./pid-file.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tokama-pid-file-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("readPidFile", () => {
  it("reads the pid, every field and the write time", () => {
    const path = join(dir, "home.lock");
    writeFileSync(path, "48211 e-1 /run/engine.sock\n");
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    expect(readPidFile(path)).toMatchObject({ pid: 48211, fields: ["48211", "e-1", "/run/engine.sock"], writtenAt: 1_700_000_000_000, text: "48211 e-1 /run/engine.sock" });
  });

  it("reads a marker that holds only a pid", () => {
    const path = join(dir, "desktop.running");
    writeFileSync(path, "300\n");
    expect(readPidFile(path)).toMatchObject({ pid: 300, fields: ["300"] });
  });

  it.each([
    ["an empty file (a lock being written)", "", []],
    ["a word", "not a lock\n", ["not", "a", "lock"]],
    ["a negative pid", "-5 e-1\n", ["-5", "e-1"]],
    ["pid 0", "0 e-1\n", ["0", "e-1"]],
    ["a pid with a tail", "12ab e-1\n", ["12ab", "e-1"]],
  ])("gives no pid for %s, but still the file", (_, content, fields) => {
    const path = join(dir, "engine.lock");
    writeFileSync(path, content);
    expect(readPidFile(path)).toMatchObject({ pid: undefined, fields });
  });

  it("is undefined for a missing file, a symlink, a folder and a large file", () => {
    expect(readPidFile(join(dir, "missing"))).toBeUndefined();
    const target = join(dir, "target");
    writeFileSync(target, "48211 e-1\n");
    symlinkSync(target, join(dir, "link"));
    expect(readPidFile(join(dir, "link"))).toBeUndefined();
    expect(readPidFile(dir)).toBeUndefined();
    writeFileSync(join(dir, "large"), `48211 ${"x".repeat(600)}\n`);
    expect(readPidFile(join(dir, "large"))).toBeUndefined();
  });
});

describe("pidAlive", () => {
  const failWith = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it("is true for a live process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("is true for another user's process (EPERM)", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(failWith("EPERM"));
    expect(pidAlive(4242)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it("is false for a process that is gone (ESRCH) and on any other error", () => {
    vi.spyOn(process, "kill").mockImplementation(failWith("ESRCH"));
    expect(pidAlive(4242)).toBe(false);
    vi.spyOn(process, "kill").mockImplementation(failWith("EINVAL"));
    expect(pidAlive(4242)).toBe(false);
  });

  it.each([0, -1, -4242, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])("never signals %d: it would name a group, or no process", (pid) => {
    const kill = vi.spyOn(process, "kill");
    expect(pidAlive(pid)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
