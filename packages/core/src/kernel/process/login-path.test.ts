import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LoginPathDeps, mergePaths, parseMarkedPath, resolveToolsPath } from "./login-path.js";
import type { ProcessRunner, RunFinished, RunRequest, RunResult } from "./runner.js";

const NONCE = "abc123";
const M = `__TOKAMA_PATH_${NONCE}__`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function shellFile(mode: number, name = "zsh"): string {
  const dir = mkdtempSync(join(tmpdir(), "tk-login-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, mode);
  return file;
}

const FINISHED: RunFinished = { kind: "finished", pid: 1, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 1, durationMs: 1 };

/** A runner that records its requests and answers with the given lines and result. */
function fakeRunner(lines: readonly string[], result: RunResult | Error = FINISHED) {
  const requests: RunRequest[] = [];
  const runner: ProcessRunner = {
    async run(request) {
      requests.push(request);
      if (result instanceof Error) throw result;
      lines.forEach((line) => request.stdout?.onLine?.(line));
      return result;
    },
  };
  return { runner, requests };
}

const present = (...dirs: string[]) => (path: string) => dirs.includes(path);

function deps(overrides: Partial<LoginPathDeps> & { runner: ProcessRunner }): LoginPathDeps {
  return { platform: "darwin", shell: shellFile(0o755), inheritedPath: "/usr/bin:/bin", home: "/Users/a", nonce: () => NONCE, isDirectory: () => true, ...overrides };
}

describe("resolveToolsPath", () => {
  it("puts the shell's entries first, then the inherited ones it lacks, and ignores other output", async () => {
    const { runner } = fakeRunner(["Last login: today", M, "/opt/homebrew/bin:/Users/a/.local/bin:/usr/bin", M, "bye"]);
    const found = await resolveToolsPath(deps({ runner, inheritedPath: "/usr/bin:/bin:/usr/sbin" }));
    expect(found).toEqual({ path: "/opt/homebrew/bin:/Users/a/.local/bin:/usr/bin:/bin:/usr/sbin", source: "login-shell", shell: "zsh" });
  });

  it("still finds the answer after 500 noise lines", async () => {
    const noise = Array.from({ length: 500 }, (_, index) => `noise ${index}`);
    const { runner } = fakeRunner([...noise, M, "/opt/homebrew/bin", M]);
    expect((await resolveToolsPath(deps({ runner }))).path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("finds the answer when text without a line break is glued to the first marker", async () => {
    const { runner } = fakeRunner([`Welcome${M}`, "/opt/homebrew/bin", M]);
    expect((await resolveToolsPath(deps({ runner }))).source).toBe("login-shell");
  });

  it("starts the shell as an interactive login shell, with the system PATH, in the home folder", async () => {
    const { runner, requests } = fakeRunner([M, "/usr/bin", M]);
    const shell = shellFile(0o755);
    await resolveToolsPath(deps({ runner, shell }));
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const argv = "argv" in request.command ? request.command.argv : [];
    expect(argv.slice(0, 4)).toEqual([shell, "-i", "-l", "-c"]);
    expect(argv[4]).toBe(`echo ${M}; /usr/bin/printenv PATH; echo ${M}`);
    expect(request.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    expect(request.cwd).toBe("/Users/a");
    expect(request.timeoutMs).toBe(5_000);
  });

  it("keeps the PATH of a shell that printed it and then hung until the timeout", async () => {
    const { runner } = fakeRunner([M, "/opt/homebrew/bin", M], { ...FINISHED, timedOut: true, exitCode: null, signal: "SIGKILL" });
    expect(await resolveToolsPath(deps({ runner }))).toMatchObject({ source: "login-shell", path: "/opt/homebrew/bin:/usr/bin:/bin" });
  });

  it("starts csh and tcsh with -c alone, which is the only form they take with -l", async () => {
    for (const name of ["csh", "tcsh"]) {
      const { runner, requests } = fakeRunner([M, "/usr/bin", M]);
      const shell = shellFile(0o755, name);
      await resolveToolsPath(deps({ runner, shell }));
      const command = requests[0]!.command;
      expect("argv" in command ? command.argv.slice(0, 2) : []).toEqual([shell, "-c"]);
    }
  });

  it("uses a new marker for each run by default", async () => {
    const seen: string[] = [];
    const runner: ProcessRunner = {
      async run(request) {
        seen.push("argv" in request.command ? (request.command.argv[4] ?? "") : "");
        return FINISHED;
      },
    };
    const shell = shellFile(0o755);
    const plain = { platform: "darwin", shell, inheritedPath: "/usr/bin", home: "/Users/a", runner } as const;
    await resolveToolsPath(plain);
    await resolveToolsPath(plain);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("does not take an answer printed with another marker", async () => {
    const { runner } = fakeRunner(["__TOKAMA_PATH_other__", "/tmp/evil", "__TOKAMA_PATH_other__"]);
    const found = await resolveToolsPath(deps({ runner }));
    expect(found.source).toBe("inherited");
    expect(found.problem).toContain("did not report a PATH");
  });

  describe("falls back to the inherited PATH and says why", () => {
    const cases: Array<[string, string[], RunResult | Error, string]> = [
      ["the shell did not start", [], { kind: "not-started", reason: "spawn-error", message: "ENOENT" }, "Tokama could not start your login shell (zsh)."],
      ["the shell timed out", [], { ...FINISHED, timedOut: true, exitCode: null, signal: "SIGTERM" }, "Your login shell (zsh) did not answer within 5 s."],
      ["the runner rejects", [], new Error("boom"), "Tokama could not start your login shell (zsh)."],
      ["there is no marker", ["hello"], FINISHED, "Your login shell (zsh) did not report a PATH."],
      ["there is one marker", [M, "/opt/homebrew/bin"], FINISHED, "Your login shell (zsh) did not report a PATH."],
      ["there are two lines between the markers", [M, "/a", "/b", M], FINISHED, "Your login shell (zsh) did not report a PATH."],
      ["the PATH has a control character", [M, "/a:\u0007/b", M], FINISHED, "Your login shell (zsh) did not report a PATH."],
      ["the PATH is empty", [M, M], FINISHED, "Your login shell (zsh) did not report a PATH."],
      ["the PATH is too long", [M, `/${"a".repeat(33 * 1024)}`, M], FINISHED, "Your login shell (zsh) did not report a PATH."],
      ["the merge leaves nothing", [M, "relative:.:", M], { ...FINISHED }, "Your login shell (zsh) did not report a PATH."],
    ];
    it.each(cases)("when %s", async (_name, lines, result, words) => {
      const { runner } = fakeRunner(lines, result);
      const found = await resolveToolsPath(deps({ runner, inheritedPath: "relative:/nowhere", isDirectory: () => false }));
      expect(found.source).toBe("inherited");
      expect(found.path).toBe("relative:/nowhere");
      expect(found.problem).toBe(words);
    });
  });

  it("does not start anything for a shell that is not set, relative, missing or not executable", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "tk-login-")), "zsh");
    dirs.push(join(missing, ".."));
    for (const shell of [undefined, "zsh", missing, shellFile(0o644)]) {
      const { runner, requests } = fakeRunner([M, "/usr/bin", M]);
      const found = await resolveToolsPath(deps({ runner, shell }));
      expect(found).toEqual({ path: "/usr/bin:/bin", source: "inherited", problem: "Your login shell is not set or cannot be run." });
      expect(requests).toHaveLength(0);
    }
  });

  it("returns the inherited PATH on Windows, without a problem and without starting anything", async () => {
    const { runner, requests } = fakeRunner([]);
    expect(await resolveToolsPath(deps({ runner, platform: "win32" }))).toEqual({ path: "/usr/bin:/bin", source: "inherited" });
    expect(requests).toHaveLength(0);
  });
});

describe("parseMarkedPath", () => {
  it("uses the last two markers", () => {
    expect(parseMarkedPath(["x", M, "/a", M, "y", M, "/b", M], M)).toBe("/b");
  });

  it("is undefined with fewer than two markers, or with nothing between them", () => {
    expect(parseMarkedPath([M, "/a"], M)).toBeUndefined();
    expect(parseMarkedPath([`${M}${M}`], M)).toBeUndefined();
  });
});

describe("mergePaths", () => {
  it("keeps each entry once, at its first place", () => {
    expect(mergePaths("/a:/b:/a", "/b:/c", () => true)).toBe("/a:/b:/c");
  });

  it("drops entries that are not directories, and appends inherited ones the shell left out", () => {
    expect(mergePaths("/a:/gone", "/usr/sbin:/a", present("/a", "/usr/sbin"))).toBe("/a:/usr/sbin");
  });

  it("never looks at the disk for an entry that is not absolute", () => {
    const asked: string[] = [];
    const merged = mergePaths("/a::.:~/bin:bin", undefined, (path) => (asked.push(path), true));
    expect(merged).toBe("/a");
    expect(asked).toEqual(["/a"]);
  });
});
