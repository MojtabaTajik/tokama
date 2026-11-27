import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashCount, expectedEngineCommands, installDirProblem, parseLock, parseSmokeArgs, reducedEnv, sandboxProblem } from "./smoke-installed.js";

describe("sandboxProblem", () => {
  const ps = (...lines: string[]) => `${lines.join("\n")}\n`;

  it("accepts an app whose processes all run with the sandbox", () => {
    expect(sandboxProblem(ps("/usr/lib/systemd/systemd --user", "/opt/Tokama/tokama", "/opt/Tokama/tokama --type=zygote", "/opt/Tokama/tokama --type=renderer --enable-sandbox"), "/opt/Tokama")).toBeUndefined();
  });

  it("refuses a process that runs with --no-sandbox, and says which", () => {
    expect(sandboxProblem(ps("/opt/Tokama/tokama", "/opt/Tokama/tokama --type=gpu-process --no-sandbox"), "/opt/Tokama")).toMatch(/1 process\(es\) run with --no-sandbox, e\.g\. \/opt\/Tokama\/tokama --type=gpu-process/);
  });

  it("refuses a process list with no process of the app: the check would pass for nothing", () => {
    expect(sandboxProblem(ps("/usr/bin/other --no-sandbox"), "/opt/Tokama")).toBe("no process runs from /opt/Tokama");
    expect(sandboxProblem("", "/opt/Tokama")).toBe("no process runs from /opt/Tokama");
  });

  it("does not take a folder that only starts with the same letters for the app", () => {
    expect(sandboxProblem(ps("/opt/TokamaOther/tokama --no-sandbox"), "/opt/Tokama")).toBe("no process runs from /opt/Tokama");
  });
});

describe("parseLock", () => {
  it("reads the pid and the engine id of a lock that names a socket", () => {
    expect(parseLock("4242 7b871639-c8f0-44eb-ba31-1e7d7a1d695f /tmp/tk/.tokama/run/s-1a2b3c4d.sock")).toEqual({ pid: 4242, engineId: "7b871639-c8f0-44eb-ba31-1e7d7a1d695f" });
    expect(parseLock("4242 abc /tmp/My Folder/s-1a2b3c4d.sock\n")).toEqual({ pid: 4242, engineId: "abc" });
  });

  it.each(["", "4242", "pid abc /x.sock", "4242 abc", "-1 abc /x.sock"])("refuses %j", (text) => expect(parseLock(text)).toBeUndefined());
});

describe("expectedEngineCommands", () => {
  it("is the packaged engine's Node, its entry, the engine dir and the home folder", () => {
    expect(expectedEngineCommands("/Applications/Tokama.app/Contents/Resources/engine", ["/tmp/tk-smoke-a/.tokama/run"], ["/tmp/tk-smoke-a/.tokama"])).toEqual([
      "/Applications/Tokama.app/Contents/Resources/engine/tokama-engine /Applications/Tokama.app/Contents/Resources/engine/dist/main.js --dir /tmp/tk-smoke-a/.tokama/run --home /tmp/tk-smoke-a/.tokama",
    ]);
  });

  it("has the same shape in the Linux layout", () => {
    expect(expectedEngineCommands("/opt/Tokama/resources/engine", ["/tmp/tk-smoke-a/.tokama/run"], ["/tmp/tk-smoke-a/.tokama"])).toEqual([
      "/opt/Tokama/resources/engine/tokama-engine /opt/Tokama/resources/engine/dist/main.js --dir /tmp/tk-smoke-a/.tokama/run --home /tmp/tk-smoke-a/.tokama",
    ]);
  });

  it("also names the dir as the system resolves it, where /tmp is /private/tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-smoke-test-"));
    try {
      const commands = expectedEngineCommands("/Applications/Tokama.app/Contents/Resources/engine", [dir, realpathSync(dir)], [dir]);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toMatch(/--dir \S+ --home \S+$/);
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

  it("keeps the display of a Linux session, which the app cannot start without", () => {
    const env = reducedEnv("/tmp/tk-smoke-a", { HOME: "/home/runner", PATH: "/usr/local/bin:/usr/bin", DISPLAY: ":99", XAUTHORITY: "/tmp/xvfb-run.x/Xauthority", XDG_RUNTIME_DIR: "/run/user/1001", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" });
    expect(env).toEqual({ HOME: "/tmp/tk-smoke-a", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", DISPLAY: ":99", XAUTHORITY: "/tmp/xvfb-run.x/Xauthority", XDG_RUNTIME_DIR: "/run/user/1001" });
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
    expect(args).toMatchObject({ target: { kind: "dmg", file: "/tmp/Tokama.dmg" }, installDir: undefined, home: undefined, signed: undefined });
    expect(args.out).toMatch(/apps\/desktop\/smoke-output$/);
  });

  it("reads a deb run", () => {
    expect(parseSmokeArgs(["--deb", "/tmp/Tokama.deb", "--home", "/tmp/h", "--out", "/tmp/o"])).toMatchObject({ target: { kind: "deb", file: "/tmp/Tokama.deb" }, home: "/tmp/h", out: "/tmp/o", signed: undefined });
  });

  it("reads an engine-only run of an installed rpm", () => {
    expect(parseSmokeArgs(["--rpm-engine-only"])).toMatchObject({ target: { kind: "rpm-engine-only" }, installDir: undefined, signed: undefined });
  });

  it("reads a signed run with a team and a feed URL", () => {
    expect(parseSmokeArgs(["--dmg", "/tmp/a.dmg", "--signed", "--team", "ABCDE12345", "--feed-url", "https://updates.example.test/mac/", "--install-dir", "/Applications", "--home", "/tmp/h"])).toMatchObject({
      signed: { team: "ABCDE12345", feedUrl: "https://updates.example.test/mac/" },
      installDir: "/Applications",
      home: "/tmp/h",
    });
  });

  it.each([
    ["no target", [], /exactly one of --dmg, --deb and --rpm-engine-only/],
    ["a dmg and a deb", ["--dmg", "a", "--deb", "b"], /exactly one of/],
    ["a deb and the rpm run", ["--deb", "a", "--rpm-engine-only"], /exactly one of/],
    ["--signed with a deb", ["--deb", "a", "--signed", "--team", "ABCDE12345", "--feed-url", "https://x.test/"], /belong to --dmg/],
    ["--install-dir with the rpm run", ["--rpm-engine-only", "--install-dir", "/Applications"], /belong to --dmg/],
    ["--signed without a team", ["--dmg", "a", "--signed", "--feed-url", "https://x.test/"], /--signed needs/],
    ["--signed without a feed URL", ["--dmg", "a", "--signed", "--team", "ABCDE12345"], /--signed needs/],
    ["--team without --signed", ["--dmg", "a", "--team", "ABCDE12345"], /belong to --signed/],
  ])("refuses %s", (_name, argv, message) => expect(() => parseSmokeArgs(argv)).toThrow(message));
});
