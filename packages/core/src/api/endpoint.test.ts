import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEngineDir, defaultEngineDir, engineEndpoint } from "./endpoint.js";

describe("engineEndpoint", () => {
  it("puts the socket, token and lock in the directory", () => {
    expect(engineEndpoint("/home/dev/.tokama/run", "linux")).toEqual({
      ok: true,
      value: {
        dir: "/home/dev/.tokama/run",
        socketPath: "/home/dev/.tokama/run/engine.sock",
        tokenPath: "/home/dev/.tokama/run/engine.token",
        lockPath: "/home/dev/.tokama/run/engine.lock",
        logPath: "/home/dev/.tokama/run/engine.log",
      },
    });
  });

  it("refuses a relative directory", () => {
    expect(engineEndpoint("run", "darwin")).toMatchObject({ ok: false, error: { code: "invalid_dir" } });
  });

  it("refuses a socket path longer than the platform allows", () => {
    const dir = `/${"d".repeat(91)}`; // socket path: 92 + 12 = 104 bytes
    expect(engineEndpoint(dir, "darwin")).toMatchObject({ ok: false, error: { code: "path_too_long" } });
    expect(engineEndpoint(dir, "linux").ok).toBe(true);
  });

  it("is not implemented on Windows yet", () => {
    expect(engineEndpoint("C:\\tokama", "win32")).toMatchObject({ ok: false, error: { code: "unsupported_platform" } });
  });
});

describe("defaultEngineDir", () => {
  it("prefers TOKAMA_ENGINE_DIR", () => {
    expect(defaultEngineDir({ TOKAMA_ENGINE_DIR: "/tmp/e", XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/dev", "linux")).toBe("/tmp/e");
  });

  it("uses XDG_RUNTIME_DIR on Linux", () => {
    expect(defaultEngineDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/dev", "linux")).toBe("/run/user/1000/tokama");
  });

  it("falls back to ~/.tokama/run", () => {
    expect(defaultEngineDir({ XDG_RUNTIME_DIR: "/run/user/501" }, "/Users/dev", "darwin")).toBe("/Users/dev/.tokama/run");
    expect(defaultEngineDir({ XDG_RUNTIME_DIR: "relative" }, "/home/dev", "linux")).toBe("/home/dev/.tokama/run");
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
