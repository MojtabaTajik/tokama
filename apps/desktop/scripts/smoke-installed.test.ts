import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashCount, expectedEngineCommands, installDirProblem, parseLock, parseSmokeArgs, reducedEnv } from "./smoke-installed.js";

describe("parseLock", () => {
  it("reads the pid and the engine id", () => {
    expect(parseLock("4242 7b871639-c8f0-44eb-ba31-1e7d7a1d695f")).toEqual({ pid: 4242, engineId: "7b871639-c8f0-44eb-ba31-1e7d7a1d695f" });
    expect(parseLock("4242 abc\n")).toEqual({ pid: 4242, engineId: "abc" });
  });

  it.each(["", "4242", "pid abc", "4242 a b", "-1 abc"])("refuses %j", (text) => expect(parseLock(text)).toBeUndefined());
});

describe("expectedEngineCommands", () => {
  it("is the packaged engine's Node, its entry and the engine dir", () => {
    expect(expectedEngineCommands("/Applications/Tokama.app", ["/tmp/tk-smoke-a/.tokama/run"])).toEqual([
      "/Applications/Tokama.app/Contents/Resources/engine/tokama-engine /Applications/Tokama.app/Contents/Resources/engine/dist/main.js --dir /tmp/tk-smoke-a/.tokama/run",
    ]);
  });

  it("also names the dir as the system resolves it, where /tmp is /private/tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-smoke-test-"));
    try {
      const commands = expectedEngineCommands("/Applications/Tokama.app", [dir, realpathSync(dir)]);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toMatch(/--dir \S+$/);
      expect(commands[1]).toContain(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reducedEnv", () => {
  it("keeps only HOME, a PATH without node and a few login variables", () => {
    const env = reducedEnv("/tmp/tk-smoke-a", {
      HOME: "/Users/someone",
      PATH: "/opt/homebrew/bin:/usr/bin",
      USER: "someone",
      LOGNAME: "someone",
      TMPDIR: "/var/folders/x/",
      LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh",
      TOKAMA_ENGINE_DIR: "/elsewhere",
      XDG_RUNTIME_DIR: "/elsewhere",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect",
      GITHUB_TOKEN: "secret",
    });
    expect(env).toEqual({
      HOME: "/tmp/tk-smoke-a",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      USER: "someone",
      LOGNAME: "someone",
      TMPDIR: "/var/folders/x/",
      LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh",
    });
  });

  it("leaves out a variable the parent does not have", () => {
    expect(reducedEnv("/tmp/h", { USER: "someone" })).toEqual({ HOME: "/tmp/h", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", USER: "someone" });
  });
});

describe("installDirProblem", () => {
  it("accepts the two folders that need no move prompt", () => {
    expect(installDirProblem("/Applications", "/Users/someone")).toBeUndefined();
    expect(installDirProblem("/Users/someone/Applications", "/Users/someone")).toBeUndefined();
  });

  it.each(["/tmp", "/Applications/Sub", "/Users/someone/Desktop", "/Users/other/Applications", "Applications"])("refuses %s", (dir) => {
    expect(installDirProblem(dir, "/Users/someone")).toMatch(/must be \/Applications or /);
  });
});

describe("crashCount", () => {
  it("counts the crash entries of a diagnostics_list reply", () => {
    expect(crashCount({ entries: [{ type: "crash", source: "engine", kind: "unclean_exit" }, { type: "usage" }, { type: "crash", source: "renderer", kind: "crashed" }] })).toBe(2);
  });

  it.each([{ entries: [] }, { entries: [{ type: "usage" }] }, {}, null, "no", { entries: "x" }])("finds none in %j", (data) => expect(crashCount(data)).toBe(0));
});

describe("parseSmokeArgs", () => {
  it("reads an unsigned run, with defaults", () => {
    const args = parseSmokeArgs(["--dmg", "/tmp/Tokama.dmg"]);
    expect(args).toMatchObject({ dmg: "/tmp/Tokama.dmg", installDir: undefined, home: undefined, signed: undefined });
    expect(args.out).toMatch(/apps\/desktop\/smoke-output$/);
  });

  it("reads a signed run with a team and a feed URL", () => {
    expect(parseSmokeArgs(["--dmg", "/tmp/a.dmg", "--signed", "--team", "ABCDE12345", "--feed-url", "https://updates.example.test/mac/", "--install-dir", "/Applications", "--home", "/tmp/h"])).toMatchObject({
      signed: { team: "ABCDE12345", feedUrl: "https://updates.example.test/mac/" },
      installDir: "/Applications",
      home: "/tmp/h",
    });
  });

  it.each([
    ["no dmg", [], /--dmg/],
    ["--signed without a team", ["--dmg", "a", "--signed", "--feed-url", "https://x.test/"], /--signed needs/],
    ["--signed without a feed URL", ["--dmg", "a", "--signed", "--team", "ABCDE12345"], /--signed needs/],
    ["--team without --signed", ["--dmg", "a", "--team", "ABCDE12345"], /belong to --signed/],
  ])("refuses %s", (_name, argv, message) => expect(() => parseSmokeArgs(argv)).toThrow(message));
});
