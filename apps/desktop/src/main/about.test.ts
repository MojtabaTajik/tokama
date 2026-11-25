import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aboutInfo, readEnginePid, tildePath } from "./about.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-118-about-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readEnginePid", () => {
  it("reads the first word of the lock file", () => {
    writeFileSync(join(dir, "engine.lock"), "48211 e-1\n");
    expect(readEnginePid(join(dir, "engine.lock"))).toBe(48211);
  });

  it("gives nothing for a missing file or a first word that is no pid", () => {
    expect(readEnginePid(join(dir, "missing.lock"))).toBeUndefined();
    for (const content of ["", "abc 1", "0 x", "-5", "12abc"]) {
      writeFileSync(join(dir, "engine.lock"), content);
      expect(readEnginePid(join(dir, "engine.lock"))).toBeUndefined();
    }
  });

  it("never follows a symlink in place of the lock", () => {
    writeFileSync(join(dir, "elsewhere"), "48211 e-1\n");
    symlinkSync(join(dir, "elsewhere"), join(dir, "engine.lock"));
    expect(readEnginePid(join(dir, "engine.lock"))).toBeUndefined();
  });
});

describe("tildePath", () => {
  it("writes the user's home folder as ~, only at a folder boundary", () => {
    expect(tildePath("/Users/dev/.tokama", "/Users/dev")).toBe("~/.tokama");
    expect(tildePath("/Users/dev", "/Users/dev")).toBe("~");
    expect(tildePath("/Users/developer/.tokama", "/Users/dev")).toBe("/Users/developer/.tokama");
  });
});

describe("aboutInfo", () => {
  const deps = { version: "0.1.0", build: { built: "2026-11-24", commit: "85a75e3" }, apiVersion: 4, tokamaHome: "/Users/dev/.tokama", userHome: "/Users/dev", platform: "darwin", arch: "arm64", versions: { electron: "45.4.1", node: "24.1.0" } } as const;

  it("collects the build facts, with the pid from the lock file", () => {
    writeFileSync(join(dir, "engine.lock"), "77 e-1");
    expect(aboutInfo({ ...deps, lockPath: join(dir, "engine.lock") })).toEqual({
      app: { version: "0.1.0", built: "2026-11-24", commit: "85a75e3" },
      engine: { version: "0.1.0", apiVersion: 4, pid: 77 },
      dataFolder: "~/.tokama",
      runtime: { electron: "45.4.1", node: "24.1.0" },
      platform: "macOS · arm64",
    });
  });

  it("leaves the pid out without a lock file, and names unknown versions and systems as they are", () => {
    const info = aboutInfo({ ...deps, lockPath: join(dir, "none"), platform: "freebsd", versions: {} });
    expect(info.engine).toEqual({ version: "0.1.0", apiVersion: 4 });
    expect([info.runtime, info.platform]).toEqual([{ electron: "unknown", node: "unknown" }, "freebsd · arm64"]);
  });
});
