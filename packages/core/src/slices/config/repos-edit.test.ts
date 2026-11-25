import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Git, GitError, WorktreeEntry } from "../../kernel/git/index.js";
import { err, ok } from "../../kernel/result/index.js";
import { addRepo, loadRepos, removeRepo, suggestRepo, updateRepo, type RepoEditOptions } from "./index.js";

let root: string;
let home: string;
/** Folders the fake git treats as repo top folders, with their branch (undefined: detached HEAD). */
let worktrees: Map<string, string | undefined>;
/** What the fake git answers for a folder it doesn't know. */
let gitError: GitError;
/** Folders the fake git gives no HEAD commit. */
let unborn: Set<string>;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-repos-edit-")));
  home = join(root, "tokama-home");
  worktrees = new Map();
  unborn = new Set();
  gitError = { reason: "failed", args: [], exitCode: 128, message: "fatal: not a git repository (or any of the parent directories): .git" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git: Pick<Git, "worktreeList" | "revParse"> = {
  revParse: async (repo) => (unborn.has(repo) ? err({ reason: "failed", args: [], exitCode: 128, message: "fatal: Needed a single revision" }) : ok("a".repeat(40))),
  worktreeList: async (repo) => {
    if (!worktrees.has(repo)) return err(gitError);
    const branch = worktrees.get(repo);
    const entry: WorktreeEntry = { path: repo, detached: branch === undefined, bare: false, ...(branch === undefined ? {} : { branch: `refs/heads/${branch}` }) };
    return ok([entry]);
  },
};
const options = (): RepoEditOptions => ({ tokamaHome: home, home: "/home/dev", git });
const reposFile = () => join(home, "repos.yaml");

/** A folder the fake git sees as a repo on `branch`, with the given files. */
function repo(name: string, files: Record<string, string> = {}, branch: string | null = "main"): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  worktrees.set(path, branch ?? undefined);
  return path;
}

async function ids(): Promise<string[]> {
  const loaded = await loadRepos({ tokamaHome: home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  return loaded.value.map((entry) => entry.id);
}

describe("addRepo", () => {
  it("creates repos.yaml with the format version, mode 0600, and no temp file left", async () => {
    const path = repo("orders-api");
    const added = await addRepo(options(), { path, checks: ["pnpm test"] });
    expect(added).toEqual({ ok: true, value: { id: "orders-api", path, baseBranch: "main", worktreeFolder: ".tokama/wt", checks: ["pnpm test"] } });
    const text = readFileSync(reposFile(), "utf8");
    expect(text).toMatch(/^# .*\n\nformat: 1\nrepos:\n {2}- id: orders-api\n/);
    expect(text).toContain(`path: ${path}\n`);
    expect(statSync(reposFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(["repos.yaml"]);
    expect(await ids()).toEqual(["orders-api"]);
  });

  it("keeps the user's comments, order and format line", async () => {
    mkdirSync(home);
    const before = `# My repos.
format: 1
repos:
  # The API first.
  - id: billing
    path: /srv/billing # on the big disk
    base_branch: main
  - { id: web, path: /srv/web, base_branch: develop }
# The end.
`;
    writeFileSync(reposFile(), before);
    const path = repo("orders-api");
    expect((await addRepo(options(), { path, id: "orders", baseBranch: "release/2.x" })).ok).toBe(true);
    const after = readFileSync(reposFile(), "utf8");
    for (const line of ["# My repos.", "  # The API first.", "    path: /srv/billing # on the big disk", "  - { id: web, path: /srv/web, base_branch: develop }", "# The end."]) {
      expect(after).toContain(line);
    }
    expect(after.indexOf("id: billing")).toBeLessThan(after.indexOf("id: web"));
    expect(await ids()).toEqual(["billing", "web", "orders"]);

    expect((await removeRepo(options(), "web")).ok).toBe(true);
    const removed = readFileSync(reposFile(), "utf8");
    expect(removed).not.toContain("id: web");
    expect(removed).toContain("# My repos.");
    expect(removed).toContain("# on the big disk");
    expect(await ids()).toEqual(["billing", "orders"]);
  });

  it("adds to an empty flow list as a block list", async () => {
    mkdirSync(home);
    writeFileSync(reposFile(), "format: 1\nrepos: []\n");
    expect((await addRepo(options(), { path: repo("a") })).ok).toBe(true);
    expect(readFileSync(reposFile(), "utf8")).toMatch(/repos:\n {2}- id: a\n/);
  });

  it("writes the file behind a linked repos.yaml and keeps the link", async () => {
    mkdirSync(home);
    mkdirSync(join(root, "dotfiles"));
    const target = join(root, "dotfiles", "repos.yaml");
    writeFileSync(target, "format: 1\nrepos: []\n");
    symlinkSync(target, reposFile());
    expect((await addRepo(options(), { path: repo("a") })).ok).toBe(true);
    expect(lstatSync(reposFile()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("id: a");
    expect(readdirSync(join(root, "dotfiles"))).toEqual(["repos.yaml"]);
  });

  it("refuses a duplicate id and the same folder twice, also through a link", async () => {
    const path = repo("orders-api");
    expect((await addRepo(options(), { path })).ok).toBe(true);
    const before = readFileSync(reposFile(), "utf8");
    symlinkSync(path, join(root, "link-to-orders"));
    expect(await addRepo(options(), { path: join(root, "link-to-orders"), id: "other" })).toEqual({
      ok: false,
      error: { code: "already_exists", message: "This folder is already added as 'orders-api'." },
    });
    expect(await addRepo(options(), { path: repo("second"), id: "orders-api" })).toEqual({
      ok: false,
      error: { code: "already_exists", message: "A repo with the id 'orders-api' is already added." },
    });
    expect(readFileSync(reposFile(), "utf8")).toBe(before);
  });

  it("refuses a folder that isn't a git repo, is missing, or isn't a full path", async () => {
    mkdirSync(join(root, "plain"));
    writeFileSync(join(root, "file.txt"), "x");
    const cases: [string, string][] = [
      [join(root, "plain"), "This folder isn't a git repo."],
      [join(root, "missing"), `The folder '${join(root, "missing")}' doesn't exist.`],
      [join(root, "file.txt"), `'${join(root, "file.txt")}' isn't a folder.`],
      ["code/orders-api", "The folder must be a full path, such as /home/me/code/orders-api."],
      ["/a\0b", "The folder must be a full path, such as /home/me/code/orders-api."],
    ];
    for (const [path, message] of cases) expect(await addRepo(options(), { path }), path).toEqual({ ok: false, error: { code: "invalid_request", message } });
    expect(() => statSync(reposFile())).toThrow();
  });

  it("tells when git can't run or refuses the folder, rather than calling it no repo", async () => {
    mkdirSync(join(root, "plain"));
    const message = async () => {
      const result = await addRepo(options(), { path: join(root, "plain") });
      return result.ok ? "added" : result.error.message;
    };
    gitError = { reason: "spawn-error", args: [], exitCode: null, message: "spawn git ENOENT" };
    expect(await message()).toBe("Tokama couldn't run git to check this folder (spawn-error).");
    gitError = { reason: "timed-out", args: [], exitCode: null, message: "" };
    expect(await message()).toBe("Tokama couldn't run git to check this folder (timed-out).");
    gitError = { reason: "failed", args: [], exitCode: 128, message: "fatal: detected dubious ownership in repository at '/x'\nTo add an exception..." };
    expect(await message()).toBe("git can't use this folder: detected dubious ownership in repository at '/x'");
  });

  it("refuses a check that isn't one simple command, a bad branch, and a bad id", async () => {
    const path = repo("a");
    const refused = async (input: Parameters<typeof addRepo>[1]) => {
      const result = await addRepo(options(), input);
      return result.ok ? "added" : result.error.message;
    };
    expect(await refused({ path, checks: ["pnpm test", "pnpm build && rm -rf /"] })).toBe("The check 'pnpm build && rm -rf /' must be one command, with no &&, ||, ; or |.");
    expect(await refused({ path, checks: ["pnpm test > out"] })).toBe("The check 'pnpm test > out' can't use a redirect (>, <).");
    expect(await refused({ path, baseBranch: "--force" })).toBe("The base branch '--force' must be a branch name, such as main.");
    expect(await refused({ path, id: "Orders API" })).toBe("The id 'Orders API' must be lowercase letters, digits and hyphens (at most 64).");
    expect(() => statSync(reposFile())).toThrow();
    // Blank checks are dropped, not refused.
    expect(await refused({ path, checks: ["  ", " pnpm test "] })).toBe("added");
    expect(readFileSync(reposFile(), "utf8")).toContain("- pnpm test\n");
  });

  it("keeps check commands to 500 characters, as loading does", async () => {
    const path = repo("a");
    const long = `pnpm test ${"x".repeat(491)}`;
    expect(long).toHaveLength(501);
    expect(await addRepo(options(), { path, checks: [long] })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("must be at most 500 characters") } });
    expect((await addRepo(options(), { path, checks: [long.slice(0, 500)] })).ok).toBe(true);
    writeFileSync(reposFile(), `format: 1\nrepos:\n  - { id: b, path: /b, base_branch: main, checks: ["${long}"] }\n`);
    const loaded = await loadRepos({ tokamaHome: home });
    expect(loaded.ok ? "loaded" : loaded.error.problems[0]?.message).toBe("checks item 1 must be at most 500 characters");
  });

  it("never takes a reserved id, such as a sample repo's, and suggests the next one", async () => {
    const reserved = { ...options(), reservedIds: ["orders-api"] };
    const path = repo("orders-api");
    expect(await suggestRepo(reserved, path)).toMatchObject({ ok: true, value: { id: "orders-api-2", problem: undefined } });
    expect(await addRepo(reserved, { path, id: "orders-api" })).toEqual({
      ok: false,
      error: { code: "already_exists", message: "The id 'orders-api' is taken by a sample repo. Pick another id." },
    });
    expect(await addRepo(reserved, { path })).toMatchObject({ ok: true, value: { id: "orders-api-2" } });
  });

  it("needs a base branch when HEAD is detached", async () => {
    const path = repo("a", {}, null);
    expect(await addRepo(options(), { path })).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "The repo has no current branch (its HEAD is detached). Give a base branch, such as main." },
    });
    expect((await addRepo(options(), { path, baseBranch: "main" })).ok).toBe(true);
  });

  it("never rewrites a repos.yaml that has problems", async () => {
    mkdirSync(home);
    const broken = "format: 1\nrepos:\n  - { id: a, path: /a }\n";
    writeFileSync(reposFile(), broken);
    expect(await addRepo(options(), { path: repo("b") })).toEqual({
      ok: false,
      error: { code: "invalid_config", message: "repos.yaml has problems; fix them first. repos.yaml line 3: base_branch is missing" },
    });
    expect(await removeRepo(options(), "a")).toMatchObject({ ok: false, error: { code: "invalid_config" } });
    expect(readFileSync(reposFile(), "utf8")).toBe(broken);
  });
});

describe("a repo without commits", () => {
  it("is refused by addRepo and reported by suggestRepo", async () => {
    const path = repo("fresh");
    unborn.add(path);
    const message = "This repo has no commits yet. Make a first commit, then add it.";
    expect(await suggestRepo(options(), path)).toMatchObject({ ok: true, value: { gitRepo: true, hasCommits: false, branch: "main", problem: message } });
    expect(await addRepo(options(), { path })).toEqual({ ok: false, error: { code: "invalid_request", message } });
    expect(existsSync(reposFile())).toBe(false);
    unborn.delete(path);
    expect(await addRepo(options(), { path })).toMatchObject({ ok: true });
  });

  it("is not taken for a git failure: only a git that cannot run is reported as that", async () => {
    const path = repo("odd");
    const broken: RepoEditOptions = { ...options(), git: { ...git, revParse: async () => err({ reason: "timed-out", args: [], exitCode: null, message: "" }) } };
    expect(await suggestRepo(broken, path)).toMatchObject({ ok: true, value: { gitRepo: false, problem: "Tokama couldn't run git to check this folder (timed-out)." } });
  });
});

describe("updateRepo", () => {
  const FILE = `# My repos.
format: 1
repos:
  # first
  - id: a
    path: PATH_A
    base_branch: main # trunk
    checks:
      # tests first
      - pnpm test
  - id: b
    path: PATH_B
    base_branch: develop
`;
  async function seed(): Promise<void> {
    const a = repo("a");
    const b = repo("b");
    mkdirSync(home, { recursive: true });
    writeFileSync(reposFile(), FILE.replace("PATH_A", a).replace("PATH_B", b));
  }

  it("replaces the base branch and the checks, keeps comments and the other repo, and leaves no temp file", async () => {
    await seed();
    const updated = await updateRepo(options(), { repoId: "a", baseBranch: " release/1 ", checks: ["pnpm test", " pnpm lint ", ""] });
    expect(updated).toMatchObject({ ok: true, value: { id: "a", baseBranch: "release/1", checks: ["pnpm test", "pnpm lint"] } });
    const text = readFileSync(reposFile(), "utf8");
    expect(text).toContain("# My repos.");
    expect(text).toContain("  # first\n");
    expect(text).toContain("base_branch: release/1 # trunk");
    expect(text).toContain("# tests first");
    expect(text).toContain("- pnpm lint");
    expect(text).toContain("base_branch: develop");
    expect(readdirSync(home)).toEqual(["repos.yaml"]);
    expect(statSync(reposFile()).mode & 0o777).toBe(0o600);
    const loaded = await loadRepos({ tokamaHome: home });
    expect(loaded).toMatchObject({ ok: true, value: [{ id: "a", baseBranch: "release/1", checks: ["pnpm test", "pnpm lint"] }, { id: "b", baseBranch: "develop", checks: [] }] });
  });

  it("keeps a comment on a check line that stays, and the flow style of a list", async () => {
    const a = repo("a");
    mkdirSync(home, { recursive: true });
    writeFileSync(reposFile(), `format: 1\nrepos:\n  - id: a\n    path: ${a}\n    base_branch: main\n    checks:\n      - pnpm test # unit tests\n      - pnpm lint # style\n`);
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "develop", checks: ["pnpm test", "pnpm lint"] })).toMatchObject({ ok: true });
    let text = readFileSync(reposFile(), "utf8");
    expect(text).toContain("- pnpm test # unit tests");
    expect(text).toContain("- pnpm lint # style");
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "develop", checks: ["pnpm lint", "pnpm build"] })).toMatchObject({ ok: true });
    text = readFileSync(reposFile(), "utf8");
    expect(text).toContain("- pnpm lint # style");
    expect(text).not.toContain("unit tests");
    expect(text).toContain("- pnpm build");
  });

  it("adds checks to a repo that had none, and removes them with an empty list", async () => {
    await seed();
    expect(await updateRepo(options(), { repoId: "b", baseBranch: "develop", checks: ["npm test"] })).toMatchObject({ ok: true });
    expect(readFileSync(reposFile(), "utf8")).toMatch(/base_branch: develop\n {4}checks:\n {6}- npm test\n/);
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "main", checks: [] })).toMatchObject({ ok: true, value: { checks: [] } });
    expect(readFileSync(reposFile(), "utf8")).not.toContain("pnpm test");
    expect(await loadRepos({ tokamaHome: home })).toMatchObject({ ok: true, value: [{ checks: [] }, { checks: ["npm test"] }] });
  });

  it("refuses what addRepo refuses, and writes nothing", async () => {
    await seed();
    const before = readFileSync(reposFile(), "utf8");
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "bad branch", checks: [] })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("base branch") } });
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "", checks: [] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "main", checks: ["a && b"] })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("no &&") } });
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "main", checks: ["x".repeat(501)] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(readFileSync(reposFile(), "utf8")).toBe(before);
  });

  it("answers not_found for an unknown id, also without a file, and never rewrites a broken file", async () => {
    expect(await updateRepo(options(), { repoId: "nope", baseBranch: "main", checks: [] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    await seed();
    expect(await updateRepo(options(), { repoId: "nope", baseBranch: "main", checks: [] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    writeFileSync(reposFile(), "format: 9\nrepos: []\n");
    expect(await updateRepo(options(), { repoId: "a", baseBranch: "main", checks: [] })).toMatchObject({ ok: false, error: { code: "invalid_config" } });
  });
});

describe("removeRepo", () => {
  it("removes the repo and leaves its folder alone", async () => {
    const path = repo("a", { "keep.txt": "x" });
    await addRepo(options(), { path });
    await addRepo(options(), { path: repo("b") });
    expect(await removeRepo(options(), "a")).toMatchObject({ ok: true, value: { id: "a", path } });
    expect(await ids()).toEqual(["b"]);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("x");
    expect(statSync(reposFile()).mode & 0o777).toBe(0o600);
  });

  it("answers not_found for an unknown id, also without a file", async () => {
    expect(await removeRepo(options(), "nope")).toEqual({ ok: false, error: { code: "not_found", message: "No repo has the id 'nope'." } });
    await addRepo(options(), { path: repo("a") });
    expect(await removeRepo(options(), "nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("suggestRepo", () => {
  it("suggests pnpm checks from package.json scripts and the pnpm lockfile", async () => {
    const path = repo("Orders_API", { "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", build: "tsc" } }), "pnpm-lock.yaml": "" }, "develop");
    expect(await suggestRepo(options(), path)).toEqual({
      ok: true,
      value: { path, gitRepo: true, hasCommits: true, branch: "develop", id: "orders-api", checks: ["pnpm test", "pnpm lint"], fallbackCheck: undefined, problem: undefined },
    });
  });

  it("suggests npm checks without a lockfile, and skips npm's placeholder test", async () => {
    const path = repo("web", { "package.json": JSON.stringify({ scripts: { test: "jest", lint: "eslint ." } }) });
    expect(await suggestRepo(options(), path)).toMatchObject({ ok: true, value: { checks: ["npm test", "npm run lint"] } });
    writeFileSync(join(path, "package-lock.json"), "{}");
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(await suggestRepo(options(), path)).toMatchObject({ ok: true, value: { checks: [] } });
  });

  it("uses yarn with a yarn lockfile, and suggests nothing without package.json", async () => {
    const path = repo("y", { "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "" });
    expect(await suggestRepo(options(), path)).toMatchObject({ ok: true, value: { checks: ["yarn test"] } });
    expect(await suggestRepo(options(), repo("bare-files"))).toMatchObject({ ok: true, value: { checks: [] } });
  });

  it("offers node --check on the first entry file when there is no package.json", async () => {
    expect(await suggestRepo(options(), repo("js", { "index.js": "1", "main.js": "1" }))).toMatchObject({ ok: true, value: { checks: [], fallbackCheck: "node --check main.js" } });
    expect(await suggestRepo(options(), repo("js2", { "index.js": "1", "src/main.js": "1" }))).toMatchObject({ value: { fallbackCheck: "node --check src/main.js" } });
    expect(await suggestRepo(options(), repo("js3", { "index.js": "1" }))).toMatchObject({ value: { fallbackCheck: "node --check index.js" } });
    expect((await suggestRepo(options(), repo("none", { "readme.md": "x" }))) as { value: { fallbackCheck: unknown } }).toMatchObject({ value: { fallbackCheck: undefined } });
  });

  it("offers no fallback with a package.json, or when package.json gives checks", async () => {
    expect(await suggestRepo(options(), repo("pkg", { "package.json": "{}", "index.js": "1" }))).toMatchObject({ value: { checks: [], fallbackCheck: undefined } });
    expect(await suggestRepo(options(), repo("pkg2", { "package.json": JSON.stringify({ scripts: { test: "jest" } }), "index.js": "1" }))).toMatchObject({ value: { fallbackCheck: undefined } });
  });

  it("makes the suggested id unique and reports a folder added already", async () => {
    const path = repo("api");
    await addRepo(options(), { path });
    expect(await suggestRepo(options(), repo("other/api"))).toMatchObject({ ok: true, value: { id: "api-2", problem: undefined } });
    expect(await suggestRepo(options(), path)).toMatchObject({ ok: true, value: { problem: "This folder is already added as 'api'." } });
  });

  it("tells a folder that isn't a git repo, and refuses a missing one", async () => {
    mkdirSync(join(root, "plain"));
    expect(await suggestRepo(options(), join(root, "plain"))).toMatchObject({
      ok: true,
      value: { gitRepo: false, branch: undefined, id: "plain", problem: "This folder isn't a git repo." },
    });
    expect(await suggestRepo(options(), join(root, "missing"))).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });
});
