import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachTracker, engineCommand, engineCommandEnd, engineDirFor, engineEnv, engineRuntime, findExecutable, readLogTail, toolsPathInfo } from "./engine.js";

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

describe("engineEnv", () => {
  const parent = { PATH: "/usr/bin:/bin", HOME: "/Users/a", SSH_AUTH_SOCK: "/tmp/agent", ANTHROPIC_API_KEY: "sk-secret", TOKAMA_SAMPLE_HISTORY: "200", ELECTRON_RUN_AS_NODE: "1" };
  const login = { path: "/opt/homebrew/bin:/Users/a/.local/bin:/usr/bin", source: "login-shell" as const, shell: "zsh" };

  it("gives the engine the tools PATH in place of the inherited one", () => {
    expect(engineEnv(parent, login, false)).toEqual({ PATH: login.path, HOME: "/Users/a", SSH_AUTH_SOCK: "/tmp/agent" });
  });

  it("keeps the inherited PATH without a tools PATH, or when it has none", () => {
    const today = { PATH: "/usr/bin:/bin", HOME: "/Users/a", SSH_AUTH_SOCK: "/tmp/agent" };
    expect(engineEnv(parent, undefined, false)).toEqual(today);
    expect(engineEnv(parent, { path: undefined, source: "inherited" }, false)).toEqual(today);
  });

  it("still drops relative entries and tool folders from the tools PATH", () => {
    const env = engineEnv(parent, { path: "/opt/bin:bin:.:/repo/node_modules/.bin:/usr/bin", source: "login-shell" }, false);
    expect(env["PATH"]).toBe("/opt/bin:/usr/bin");
  });

  it("adds the sample history only in sample mode, and no other variable", () => {
    expect(engineEnv(parent, login, true)["TOKAMA_SAMPLE_HISTORY"]).toBe("200");
    expect(Object.keys(engineEnv(parent, login, true)).sort()).toEqual(["HOME", "PATH", "SSH_AUTH_SOCK", "TOKAMA_SAMPLE_HISTORY"]);
  });

  it("passes the history-only switch in sample mode only", () => {
    const only = { ...parent, TOKAMA_SAMPLE_ONLY_HISTORY: "1" };
    expect(engineEnv(only, login, true)["TOKAMA_SAMPLE_ONLY_HISTORY"]).toBe("1");
    expect(engineEnv(only, login, false)["TOKAMA_SAMPLE_ONLY_HISTORY"]).toBeUndefined();
  });
});

describe("attachTracker", () => {
  it("is attached when a live engine was there at the first connect", () => {
    const tracker = attachTracker();
    tracker.connecting(true);
    expect(tracker.attached()).toBe(true);
  });

  it("is not attached when this run starts the engine, also when it is found alive at a later connect", () => {
    const tracker = attachTracker();
    tracker.connecting(false);
    expect(tracker.attached()).toBe(false);
    tracker.connecting(true);
    expect(tracker.attached()).toBe(false);
  });

  it("is not attached after an older engine was replaced: the new one is this run's", () => {
    const tracker = attachTracker();
    tracker.connecting(true);
    tracker.connecting(false);
    tracker.connecting(true);
    expect(tracker.attached()).toBe(false);
  });
});

describe("toolsPathInfo", () => {
  it("keeps the source, shell and problem, and drops the PATH", () => {
    expect(toolsPathInfo({ path: "/Users/a/.local/bin:/usr/bin", source: "login-shell", shell: "zsh" })).toEqual({ source: "login-shell", shell: "zsh" });
    expect(toolsPathInfo({ path: "/Users/a/bin", source: "inherited", shell: "zsh", problem: "Your login shell (zsh) did not report a PATH." })).toEqual({
      source: "inherited",
      shell: "zsh",
      problem: "Your login shell (zsh) did not report a PATH.",
    });
    expect(toolsPathInfo({ path: undefined, source: "inherited" })).toEqual({ source: "inherited" });
    expect(toolsPathInfo({ path: "/x", source: "login-shell", shell: "zsh", slow: true })).toEqual({ source: "login-shell", shell: "zsh", slow: true });
  });

  it("says only that the engine was already running when the app attached to one", () => {
    expect(toolsPathInfo({ path: "/x", source: "inherited", shell: "zsh", problem: "Your login shell (zsh) did not report a PATH." }, true)).toEqual({ source: "engine-running" });
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

describe("engineRuntime", () => {
  const resourcesPath = "/Applications/Tokama.app/Contents/Resources";
  const appPath = `${resourcesPath}/app.asar`;
  const withNodeOnPath = () => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "node"), 0o755);
    return join(dir, "bin");
  };

  it("in development: the node on PATH and the built engine of the checkout", () => {
    const path = withNodeOnPath();
    expect(engineRuntime({ platform: "darwin", isPackaged: false, appPath: "/src/tokama/apps/desktop", resourcesPath, path })).toEqual({ node: join(path, "node"), entry: "/src/tokama/apps/engine/dist/main.js" });
  });

  it("in development: no node when none is on PATH", () => {
    expect(engineRuntime({ platform: "darwin", isPackaged: false, appPath: "/src/tokama/apps/desktop", resourcesPath, path: dir }).node).toBeUndefined();
  });

  it("packaged: the app's own Node and engine bundle, whatever PATH holds", () => {
    const path = withNodeOnPath();
    expect(engineRuntime({ platform: "darwin", isPackaged: true, appPath, resourcesPath, path })).toEqual({ node: `${resourcesPath}/engine/tokama-engine`, entry: `${resourcesPath}/engine/dist/main.js` });
    expect(engineRuntime({ platform: "darwin", isPackaged: true, appPath, resourcesPath, path: undefined }).node).toBe(`${resourcesPath}/engine/tokama-engine`);
  });

  it("packaged on Windows: the Node binary is an .exe", () => {
    expect(engineRuntime({ platform: "win32", isPackaged: true, appPath, resourcesPath, path: undefined }).node).toBe(join(resourcesPath, "engine", "tokama-engine.exe"));
  });

  it("packaged: the engine command ends the way engineCommandEnd says, so the app finds its own engine", () => {
    const { node, entry } = engineRuntime({ platform: "darwin", isPackaged: true, appPath, resourcesPath, path: undefined });
    const command = engineCommand({ node, entry, dir: "/home/dev/.tokama/run", env: {} });
    if (!command.ok) throw new Error(command.error);
    expect([command.value.command, ...command.value.args].join(" ").endsWith(engineCommandEnd("/home/dev/.tokama/run"))).toBe(true);
  });
});

describe("engineCommandEnd", () => {
  it("is how the command line of the engine engineCommand builds ends, for the real and the sample engine", () => {
    for (const sample of [false, true]) {
      const command = engineCommand({ node: "/usr/bin/node", entry: "/src/tokama/apps/engine/dist/main.js", dir: "/home/dev/.tokama/run", env: {}, sample });
      if (!command.ok) throw new Error(command.error);
      expect([command.value.command, ...command.value.args].join(" ").endsWith(engineCommandEnd("/home/dev/.tokama/run", sample))).toBe(true);
    }
  });

  it("does not match the sample engine's dir for the real engine, or the other way round", () => {
    const sampleLine = "/usr/bin/node /src/apps/engine/dist/main.js --dir /home/dev/.tokama/run/sample --sample";
    const realLine = "/usr/bin/node /src/apps/engine/dist/main.js --dir /home/dev/.tokama/run";
    expect(sampleLine.endsWith(engineCommandEnd("/home/dev/.tokama/run"))).toBe(false);
    expect(realLine.endsWith(engineCommandEnd("/home/dev/.tokama/run/sample", true))).toBe(false);
    expect(realLine.endsWith(engineCommandEnd("/dev/.tokama/run"))).toBe(false);
  });
});
