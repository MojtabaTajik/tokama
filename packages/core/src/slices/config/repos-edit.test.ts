import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Git, WorktreeEntry } from "../../kernel/git/index.js";
import { err, ok } from "../../kernel/result/index.js";
import { addRepo, loadRepos, removeRepo, suggestRepo, type RepoEditOptions } from "./index.js";

let root: string;
let home: string;
/** Folders the fake git treats as repo top folders, with their branch (undefined: detached HEAD). */
let worktrees: Map<string, string | undefined>;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-repos-edit-")));
  home = join(root, "tokama-home");
  worktrees = new Map();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git: Pick<Git, "worktreeList"> = {
  worktreeList: async (repo) => {
    if (!worktrees.has(repo)) return err({ reason: "failed", args: [], exitCode: 128, message: "not a git repository" });
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
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
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
      value: { path, gitRepo: true, branch: "develop", id: "orders-api", checks: ["pnpm test", "pnpm lint"], problem: undefined },
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
