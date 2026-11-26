import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEngineDir, defaultEngineDir, engineEndpoint, engineLockPath, newSocketPath, tokenPathOf } from "./endpoint.js";

describe("engineEndpoint", () => {
  it("names the directory and the log", () => {
    expect(engineEndpoint("/home/dev/.tokama/run", "linux")).toEqual({
      ok: true,
      value: { dir: "/home/dev/.tokama/run", logPath: "/home/dev/.tokama/run/engine.log" },
    });
  });

  it("refuses a relative directory", () => {
    expect(engineEndpoint("run", "darwin")).toMatchObject({ ok: false, error: { code: "invalid_dir" } });
  });

  it("refuses a directory too long for a socket with the name that engines use, naming the directory", () => {
    // `/s-00000000.sock` is 16 bytes after the directory: 103 bytes is the longest path on macOS, 107 on Linux.
    const overOnMac = `/${"d".repeat(87)}`; // 88 + 16 = 104
    expect(engineEndpoint(overOnMac, "darwin")).toMatchObject({ ok: false, error: { code: "path_too_long", message: expect.stringContaining(overOnMac) } });
    expect(engineEndpoint(overOnMac, "linux").ok).toBe(true);
    expect(engineEndpoint(`/${"d".repeat(86)}`, "darwin").ok).toBe(true);
    expect(engineEndpoint(`/${"d".repeat(91)}`, "linux")).toMatchObject({ ok: false, error: { code: "path_too_long" } });
    expect(engineEndpoint(`/${"d".repeat(90)}`, "linux").ok).toBe(true);
  });

  it("is not implemented on Windows yet", () => {
    expect(engineEndpoint("C:\\tokama", "win32")).toMatchObject({ ok: false, error: { code: "unsupported_platform" } });
  });
});

describe("newSocketPath and tokenPathOf", () => {
  it("makes a short unique name in the directory, and the token is next to it", () => {
    const first = newSocketPath("/home/dev/.tokama/run");
    expect(first).toMatch(/^\/home\/dev\/\.tokama\/run\/s-[0-9a-f]{8}\.sock$/);
    expect(newSocketPath("/home/dev/.tokama/run")).not.toBe(first);
    expect(tokenPathOf("/home/dev/.tokama/run/s-1a2b3c4d.sock")).toBe("/home/dev/.tokama/run/s-1a2b3c4d.token");
    // The name an engine of an earlier build used.
    expect(tokenPathOf("/run/user/1000/tokama/engine.sock")).toBe("/run/user/1000/tokama/engine.token");
  });
});

describe("engineLockPath", () => {
  it("is in the home for a real engine, and in the engine dir for the sample engine or without a home", () => {
    expect(engineLockPath({ dir: "/home/dev/.tokama/run", home: "/home/dev/.tokama" })).toBe("/home/dev/.tokama/engine.lock");
    expect(engineLockPath({ dir: "/tmp/e/sample", home: "/home/dev/.tokama", sample: true })).toBe("/tmp/e/sample/engine.lock");
    expect(engineLockPath({ dir: "/tmp/e" })).toBe("/tmp/e/engine.lock");
  });
});

describe("defaultEngineDir", () => {
  it("prefers TOKAMA_ENGINE_DIR", () => {
    expect(defaultEngineDir({ TOKAMA_ENGINE_DIR: "/tmp/e", XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/dev")).toBe("/tmp/e");
  });

  it("uses ~/.tokama/run on Linux and macOS, even with XDG_RUNTIME_DIR", () => {
    expect(defaultEngineDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/dev")).toBe("/home/dev/.tokama/run");
    expect(defaultEngineDir({}, "/Users/dev")).toBe("/Users/dev/.tokama/run");
  });
});

describe("checkEngineDir", () => {
  const root = () => mkdtempSync(join(tmpdir(), "tk-"));

  it("accepts a private directory and reports a missing one", () => {
    const dir = root();
    expect(checkEngineDir(dir)).toEqual({ ok: true, value: undefined });
    expect(checkEngineDir(join(dir, "nope"))).toMatchObject({ ok: false, error: { code: "missing" } });
    rmSync(dir, { recursive: true });
  });

  it("refuses a symlink and a directory others can read", () => {
    const dir = root();
    mkdirSync(join(dir, "open"), { mode: 0o755 });
    chmodSync(join(dir, "open"), 0o755);
    symlinkSync(dir, join(dir, "link"));
    expect(checkEngineDir(join(dir, "open"))).toMatchObject({ ok: false, error: { code: "too_open" } });
    expect(checkEngineDir(join(dir, "link"))).toMatchObject({ ok: false, error: { code: "not_directory" } });
    rmSync(dir, { recursive: true });
  });
});
