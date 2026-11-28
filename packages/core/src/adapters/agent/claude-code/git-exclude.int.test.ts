import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeholderExcludeEnv } from "./git-exclude.js";

let root: string;
let main: string;
let item: string;

const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const run = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trimEnd();
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-exclude-test-")));
  main = join(root, "main");
  item = join(root, "item");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  mkdirSync(join(main, ".claude"));
  writeFileSync(join(main, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(main, "a.txt"), "one\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "seed"]);
  git(main, ["worktree", "add", "-q", "-b", "item", item]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("placeholderExcludeEnv", () => {
  it("makes the agent's git skip the placeholders in the worktree, and only there", () => {
    const env = placeholderExcludeEnv(item, "linux");
    if (env === undefined) throw new Error("no environment");
    // Placeholders as the sandbox shows them to the agent: files git has not seen before.
    for (const name of [".bashrc", ".gitconfig", ".vscode", ".claude/commands", ".claude/agents"]) writeFileSync(join(item, name), "");
    writeFileSync(join(item, "work.txt"), "work\n");
    git(item, ["add", "-A"], env);
    expect(git(item, ["status", "--porcelain"], env)).toBe("A  work.txt");
    // Without it git still sees them, and so does the engineer's checkout and another worktree.
    expect(git(item, ["status", "--porcelain", "-uall"])).toContain("?? .bashrc");
    writeFileSync(join(main, ".bashrc"), "");
    expect(git(main, ["status", "--porcelain"])).toBe("?? .bashrc");
  });

  it("keeps a tracked file of the same name tracked", () => {
    const env = placeholderExcludeEnv(item, "linux");
    writeFileSync(join(item, ".claude", "settings.json"), '{"a":1}\n');
    expect(git(item, ["status", "--porcelain"], env)).toBe(" M .claude/settings.json");
  });

  it("puts the exclude file in the worktree's git folder, not in the repo's shared folder", () => {
    const env = placeholderExcludeEnv(item, "linux");
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: join(main, ".git", "worktrees", "item", "tokama-exclude"),
    });
    expect(readFileSync(join(main, ".git", "info", "exclude"), "utf8")).not.toContain(".bashrc");
  });

  it("gives nothing on another OS, outside a linked worktree, or without a git folder to write to", () => {
    expect(placeholderExcludeEnv(item, "darwin")).toBeUndefined();
    expect(placeholderExcludeEnv(main, "linux")).toBeUndefined();
    expect(placeholderExcludeEnv(join(root, "missing"), "linux")).toBeUndefined();
    const stray = join(root, "stray");
    mkdirSync(stray);
    writeFileSync(join(stray, ".git"), "gitdir: ./nowhere\n");
    expect(placeholderExcludeEnv(stray, "linux")).toBeUndefined();
  });
});
