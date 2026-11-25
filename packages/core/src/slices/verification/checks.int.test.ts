import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import { checksPass, runChecks, runCommand, type RunCommandOptions } from "./checks.js";

// Ported from ai-pipeline tests/test_sampler_and_run.py (run_check: pass, exit code, timeout) and
// test_loop_stub.py (a command outside the allowlist is refused and does not run).

const SLOW = { timeout: 20_000 };
const RULES = ["echo:*", "exit:*", "sleep:*", "pwd", "printenv:*", "true", "false", "touch:*", "seq:*"];

let dir: string;
const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: tmpdir(), SECRET_TOKEN: "s3cret" } });
const options = (extra: Partial<RunCommandOptions> = {}): RunCommandOptions => ({ rules: RULES, cwd: dir, timeoutMs: 10_000, ...extra });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tokama-checks-test-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("passes on exit 0 and keeps the output", SLOW, async () => {
    expect(await runCommand(runner, "echo hi", options())).toMatchObject({ command: "echo hi", outcome: "passed", exitCode: 0, output: "hi", outputTruncated: false });
  });

  it("fails on a non-zero exit with the exit status", SLOW, async () => {
    expect(await runCommand(runner, "exit 3", options())).toMatchObject({ outcome: "failed", exitCode: 3 });
  });

  it("stops a command at its timeout", SLOW, async () => {
    const result = await runCommand(runner, "sleep 30", options({ timeoutMs: 300 }));
    expect(result.outcome).toBe("timed-out");
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("stops a command when the signal fires", SLOW, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    expect((await runCommand(runner, "sleep 30", options({ signal: controller.signal }))).outcome).toBe("aborted");
  });

  it("refuses a command outside the allowlist or with shell syntax, and does not run it", SLOW, async () => {
    const marker = join(dir, "pwned");
    const refused = await runCommand(runner, `rm -rf ${dir}`, options());
    expect(refused).toMatchObject({ outcome: "refused", exitCode: null });
    expect(refused.output).toContain("not-allowlisted");
    const chained = await runCommand(runner, `echo hi; touch ${marker} $(id)`, options());
    expect(chained).toMatchObject({ outcome: "refused" });
    expect(chained.output).toContain("substitution");
    expect(() => readFileSync(marker)).toThrow();
  });

  it("runs in the given folder with only the allowlisted environment plus extras", SLOW, async () => {
    expect((await runCommand(runner, "pwd", options())).output).toBe(dir);
    expect(await runCommand(runner, "printenv SECRET_TOKEN", options())).toMatchObject({ outcome: "failed", output: "" });
    expect((await runCommand(runner, "printenv CI", options({ env: { CI: "1" } }))).output).toBe("1");
  });

  it("keeps the tail of long output within the cap, and the full output in the given file", SLOW, async () => {
    const file = join(dir, "out.log");
    const result = await runCommand(runner, "seq 1 2000", options({ outputCap: 100, outputFile: file }));
    expect(result.outputTruncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(100);
    expect(result.output.endsWith("1999\n2000")).toBe(true);
    expect(readFileSync(file, "utf8").split("\n")).toHaveLength(2001);
  });

  it("keeps stderr with stdout, in arrival order", SLOW, async () => {
    const result = await runCommand(runner, "echo out && ls no-such-file || echo after", options({ rules: [...RULES, "ls:*"] }));
    const lines = result.output.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("out");
    expect(lines[1]).toContain("no-such-file");
    expect(lines[2]).toBe("after");
  });
});

describe("runCommand output order", () => {
  it("keeps the order a command wrote stdout and stderr in, however many switches", SLOW, async () => {
    const expected: string[] = [];
    let script = "";
    for (let i = 0; i < 200; i++) {
      script += `echo out${i}\necho err${i} >&2\n`;
      expected.push(`out${i}`, `err${i}`);
    }
    writeFileSync(join(dir, "alternate.sh"), script);
    const result = await runCommand(runner, "sh alternate.sh", options({ rules: ["sh alternate.sh"], outputCap: 100_000 }));
    expect(result.output.split("\n")).toEqual(expected);
  });
});

describe("runChecks", () => {
  it("runs every command and returns each result in order", SLOW, async () => {
    const results = await runChecks(runner, ["true", "exit 2", "echo still runs"], options());
    expect(results.map((result) => [result.command, result.outcome, result.exitCode])).toEqual([
      ["true", "passed", 0],
      ["exit 2", "failed", 2],
      ["echo still runs", "passed", 0],
    ]);
  });
});

describe("checksPass", () => {
  const signal = () => new AbortController().signal;

  it("is false for a step without checks", async () => {
    expect(await checksPass(runner, [], options())(10_000, signal())).toBe(false);
  });

  it("is true when every check passes and false at the first failure", SLOW, async () => {
    expect(await checksPass(runner, ["true", "echo ok"], options())(10_000, signal())).toBe(true);
    const marker = join(dir, "after-failure");
    expect(await checksPass(runner, ["false", `touch ${marker}`], options())(10_000, signal())).toBe(false);
    expect(() => readFileSync(marker)).toThrow();
  });

  it("shares one time budget across the checks", SLOW, async () => {
    const started = Date.now();
    expect(await checksPass(runner, ["sleep 0.3", "sleep 0.3", "sleep 30"], options())(500, signal())).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns promptly once the signal fires", SLOW, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    expect(await checksPass(runner, ["sleep 30"], options())(60_000, controller.signal)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("setup command", () => {
  it("runs in a new worktree before the first step and keeps its output; a refused one does not run", SLOW, async () => {
    const repo = join(dir, "orders-api");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      runner.run({ command: { argv: ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args] }, cwd: repo, env: { GIT_CONFIG_NOSYSTEM: "1" } });
    await git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "seed");
    const worktree = join(repo, ".tokama", "wt", "0b9f12ab");
    mkdirSync(join(repo, ".tokama", "wt"), { recursive: true });
    const added = await createGit({ runner }).worktreeAdd(repo, worktree, "tokama/0b9f12ab", "main");
    expect(added.ok).toBe(true);

    const setup = await runCommand(runner, "touch installed && echo installed", options({ cwd: worktree, rules: ["touch installed", "echo:*"] }));
    expect(setup).toMatchObject({ outcome: "passed", output: "installed" });
    expect(existsSync(join(worktree, "installed"))).toBe(true);

    const refused = await runCommand(runner, "pnpm install", options({ cwd: worktree, rules: ["touch installed"] }));
    expect(refused.outcome).toBe("refused");
  });
});
