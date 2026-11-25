import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineCommand, engineDirFor, findExecutable, otherVersionMessage, readLogTail } from "./engine.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokama-desktop-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findExecutable", () => {
  it("returns the first executable file in an absolute PATH entry", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "node"), "not executable");
    writeFileSync(join(b, "node"), "#!/bin/sh\n");
    chmodSync(join(b, "node"), 0o755);
    expect(findExecutable("node", [a, b].join(delimiter))).toBe(join(b, "node"));
  });

  it("skips relative entries and directories, and returns undefined when nothing fits", () => {
    mkdirSync(join(dir, "node"));
    expect(findExecutable("node", [".", "bin", dir].join(delimiter))).toBeUndefined();
    expect(findExecutable("node", undefined)).toBeUndefined();
  });
});

describe("engineCommand", () => {
  const input = { node: "/usr/local/bin/node", entry: "/repo/apps/engine/dist/main.js", dir: "/run/tokama", env: { HOME: "/home/a" } };

  it("runs the entry with node and passes the engine dir", () => {
    expect(engineCommand(input)).toEqual({
      ok: true,
      value: { command: "/usr/local/bin/node", args: ["/repo/apps/engine/dist/main.js", "--dir", "/run/tokama"], env: { HOME: "/home/a" } },
    });
  });

  it("adds --sample for the fake engine mode", () => {
    expect(engineCommand({ ...input, sample: true })).toMatchObject({
      ok: true,
      value: { args: ["/repo/apps/engine/dist/main.js", "--dir", "/run/tokama", "--sample"] },
    });
  });

  it("refuses a missing node and relative paths", () => {
    expect(engineCommand({ ...input, node: undefined })).toEqual({ ok: false, error: "cannot start the engine: node was not found on PATH" });
    expect(engineCommand({ ...input, node: "node" })).toMatchObject({ ok: false, error: expect.stringContaining("node binary") });
    expect(engineCommand({ ...input, entry: "dist/main.js" })).toMatchObject({ ok: false, error: expect.stringContaining("engine entry") });
    expect(engineCommand({ ...input, dir: "run" })).toMatchObject({ ok: false, error: expect.stringContaining("engine dir") });
  });
});

describe("engineDirFor", () => {
  it("gives the sample engine its own subdir and the real engine the base dir", () => {
    expect(engineDirFor("/home/a/.tokama/run", false)).toBe("/home/a/.tokama/run");
    expect(engineDirFor("/home/a/.tokama/run", true)).toBe("/home/a/.tokama/run/sample");
    expect(engineDirFor("/home/a/.tokama/run", true)).not.toBe(engineDirFor("/home/a/.tokama/run", false));
  });
});

describe("readLogTail", () => {
  it("returns the last non-empty lines", () => {
    const log = join(dir, "engine.log");
    writeFileSync(log, "one\n\ntwo\nthree\n");
    expect(readLogTail(log, 2)).toEqual(["two", "three"]);
  });

  it("drops the partial first line when it reads from the middle", () => {
    const log = join(dir, "engine.log");
    writeFileSync(log, `${"x".repeat(100)}\nlast line\n`);
    expect(readLogTail(log, 8, 16)).toEqual(["last line"]);
  });

  it("returns [] for a missing file, a folder or a symlink", () => {
    expect(readLogTail(join(dir, "missing.log"))).toEqual([]);
    expect(readLogTail(dir)).toEqual([]);
    writeFileSync(join(dir, "real.log"), "secret\n");
    symlinkSync(join(dir, "real.log"), join(dir, "link.log"));
    expect(readLogTail(join(dir, "link.log"))).toEqual([]);
  });
});

describe("otherVersionMessage", () => {
  it("names the command that stops the engine by the pid in its lock file, quoted for the shell", () => {
    expect(otherVersionMessage("/home/dev/.tokama/run/engine.lock")).toBe(
      "An older Tokama engine is still running. Quit it, then press Retry. In a terminal: kill $(cut -d' ' -f1 '/home/dev/.tokama/run/engine.lock')",
    );
    expect(otherVersionMessage("/tmp/it's/engine.lock")).toContain(`'/tmp/it'\\''s/engine.lock'`);
  });
});
