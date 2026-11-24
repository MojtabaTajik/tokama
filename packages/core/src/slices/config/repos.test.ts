import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Result } from "../../kernel/result/index.js";
import { formatProblem, loadRepos, type ConfigError, type Repo } from "./index.js";

let root: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-repos-")));
  home = join(root, "tokama-home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (content: string) => writeFileSync(join(home, "repos.yaml"), content);
const load = () => loadRepos({ tokamaHome: home, home: "/home/dev" });
function messages(result: Result<Repo[], ConfigError>): string[] {
  if (result.ok) throw new Error("expected problems");
  return result.error.problems.map(formatProblem);
}

describe("loadRepos", () => {
  it("loads repos in file order, with defaults", async () => {
    write(`format: 1
repos:
  - id: orders-api
    path: /srv/code/orders-api
    remote: https://example.com/northwind/orders-api.git
    base_branch: main
    worktree_folder: .worktrees
    checks: [pnpm test, "pnpm lint --max-warnings 0"]
  - id: billing
    path: ~/code/billing/
    base_branch: release/2.x
`);
    expect(await load()).toEqual({
      ok: true,
      value: [
        {
          id: "orders-api",
          path: "/srv/code/orders-api",
          remote: "https://example.com/northwind/orders-api.git",
          baseBranch: "main",
          worktreeFolder: ".worktrees",
          checks: ["pnpm test", "pnpm lint --max-warnings 0"],
        },
        { id: "billing", path: "/home/dev/code/billing", baseBranch: "release/2.x", worktreeFolder: ".tokama/wt", checks: [] },
      ],
    });
  });

  it("has no repos without a file, or with an empty list", async () => {
    expect(await loadRepos({ tokamaHome: join(root, "missing") })).toEqual({ ok: true, value: [] });
    write("format: 1\nrepos: []\n");
    expect(await load()).toEqual({ ok: true, value: [] });
  });

  it("names each problem with its line", async () => {
    write(`format: 1
repos:
  - id: orders-api
    path: code/orders-api
    baseBranch: main
  - id: orders-api
    path: /srv/b
    base_branch: --force
    worktree_folder: ../outside
    remote: -uhttps://evil
`);
    expect(messages(await load())).toEqual([
      "repos.yaml line 3: base_branch is missing",
      "repos.yaml line 4: path must be a full path, such as /home/me/code/orders-api or ~/code/orders-api",
      "repos.yaml line 5: 'baseBranch' isn't a known field. Did you mean base_branch?",
      "repos.yaml line 8: base_branch must be a branch name, such as main",
      "repos.yaml line 9: worktree_folder must be a folder inside the repo and outside .git, such as .tokama/wt",
      "repos.yaml line 10: remote must be a URL with no spaces or control characters, not starting with '-'",
    ]);
  });

  it("gives the same lines with CRLF line breaks", async () => {
    write("format: 1\r\nrepos:\r\n  - id: a\r\n    path: /a\r\n    base_branch: -x\r\n");
    expect(messages(await load())).toEqual(["repos.yaml line 5: base_branch must be a branch name, such as main"]);
  });

  it("refuses branch names git reads as something else", async () => {
    for (const branch of ["+main", "'@'", "HEAD", "-main", "a..b", "main.lock", "a b"]) {
      write(`format: 1\nrepos:\n  - { id: a, path: /a, base_branch: ${branch} }\n`);
      expect(messages(await load()), branch).toEqual(["repos.yaml line 3: base_branch must be a branch name, such as main"]);
    }
    write("format: 1\nrepos:\n  - { id: a, path: /a, base_branch: feature/HEAD-fix }\n");
    expect((await load()).ok).toBe(true);
  });

  it("refuses a worktree folder that is the repo itself or inside .git", async () => {
    for (const folder of [".", "./", "a/..", ".git", ".git/wt", "./.GIT/wt", "/tmp/wt", "~/wt", "../wt"]) {
      write(`format: 1\nrepos:\n  - { id: a, path: /a, base_branch: main, worktree_folder: "${folder}" }\n`);
      expect(messages(await load()), folder).toEqual([
        "repos.yaml line 3: worktree_folder must be a folder inside the repo and outside .git, such as .tokama/wt",
      ]);
    }
  });

  it("refuses a NUL character in worktree_folder", async () => {
    write('format: 1\nrepos:\n  - { id: a, path: /a, base_branch: main, worktree_folder: "wt\\0x" }\n');
    expect(messages(await load())).toContain("repos.yaml line 3: worktree_folder can't contain a NUL character");
  });

  it("refuses NUL characters in path and remote", async () => {
    write('format: 1\nrepos:\n  - id: a\n    path: "/a\\0b"\n    remote: "https://x\\0y"\n    base_branch: main\n');
    expect(messages(await load())).toEqual([
      "repos.yaml line 4: path can't contain a NUL character",
      "repos.yaml line 5: remote must be a URL with no spaces or control characters, not starting with '-'",
    ]);
  });

  it("refuses checks that are not one simple command", async () => {
    write(`format: 1
repos:
  - id: a
    path: /a
    base_branch: main
    checks:
      - pnpm test
      - pnpm build && pnpm test
      - pnpm test | tail -5
      - pnpm test > out.txt
      - echo $(whoami)
      - "pnpm test 'unclosed"
      - ""
`);
    expect(messages(await load())).toEqual([
      "repos.yaml line 8: checks item 2 must be one command, with no &&, ||, ; or |",
      "repos.yaml line 9: checks item 3 must be one command, with no &&, ||, ; or |",
      "repos.yaml line 10: checks item 4 can't use a redirect (>, <)",
      "repos.yaml line 11: checks item 5 can't use command substitution ($(...) or backticks)",
      "repos.yaml line 12: checks item 6 can't use an unclosed quote",
      "repos.yaml line 13: checks item 7 has no command words",
    ]);
  });

  it("refuses a repeated id", async () => {
    write("format: 1\nrepos:\n  - { id: a, path: /a, base_branch: main }\n  - { id: a, path: /b, base_branch: main }\n");
    expect(messages(await load())).toEqual(["repos.yaml line 4: id 'a' is used by an earlier repo"]);
  });

  it("needs the format version", async () => {
    write("repos: []\n");
    expect(messages(await load())).toEqual(["repos.yaml line 1: format is missing"]);
    write("");
    expect(messages(await load())).toEqual(["repos.yaml line 1: is empty"]);
    write("- a\n");
    expect(messages(await load())).toEqual(["repos.yaml line 1: must be a list of settings (key: value lines)"]);
  });

  it("refuses a linked repos.yaml, also one that leads nowhere", async () => {
    writeFileSync(join(root, "real.yaml"), "format: 1\nrepos: []\n");
    symlinkSync(join(root, "real.yaml"), join(home, "repos.yaml"));
    expect(messages(await load())).toEqual(["repos.yaml: Tokama doesn't follow links in config folders"]);
    rmSync(join(home, "repos.yaml"));
    symlinkSync(join(root, "gone.yaml"), join(home, "repos.yaml"));
    expect(messages(await load())).toEqual(["repos.yaml: Tokama doesn't follow links in config folders"]);
  });

  it("refuses an oversized repos.yaml", async () => {
    write(`format: 1\nrepos: []\n# ${"x".repeat(70 * 1024)}\n`);
    expect(messages(await load())).toEqual(["repos.yaml: is larger than 64 KB"]);
  });
});
