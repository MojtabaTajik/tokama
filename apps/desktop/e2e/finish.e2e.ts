// Finishing a done item from the drawer: Open PR and Discard on the sample engine, and Merge and
// Discard on the real engine with a temp repo. The real flow seeds the Tokama home before the app
// starts: a repo, and two done items whose commits sit on their own worktree branches, as the run
// loop leaves them. No remote is touched.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ItemStore, loadHostId, parseTemplateRecord, type RepoId } from "@tokama/core";
import { expect } from "vitest";
import { drawer, flow, row, segment } from "./harness.js";

const SAMPLE_DONE = "Fix the null check in cart totals";

flow("opens a pull request for a done item, then discards it after a confirmation", async ({ page, screenshot }) => {
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  await row(page, SAMPLE_DONE).click();
  const finish = drawer(page).locator(".finish");
  await finish.waitFor();
  expect(await finish.locator(".choice").allTextContents()).toEqual(["Merge into main", "Open PR", "Discard"]);
  expect(await finish.innerText()).toContain("Open PR pushes to github.com/northwind/orders-api");
  await screenshot("finish-1-offered");

  await finish.getByRole("button", { name: "Open PR" }).click();
  await expect.poll(() => finish.innerText(), { message: "the pull request line" }).toContain("Pull request opened: https://github.com/northwind/orders-api/pull/128");
  expect(await finish.locator(".choice").allTextContents()).toEqual(["Discard"]);

  await finish.getByRole("button", { name: "Discard" }).click();
  const confirm = finish.getByRole("group", { name: "Discard" });
  await confirm.getByRole("button", { name: "Keep" }).waitFor();
  await confirm.getByRole("button", { name: "Discard" }).click();
  await expect.poll(() => finish.innerText(), { message: "the discarded line" }).toContain("Discarded: the worktree and branch are removed.");
  // The list keeps the pull request as the item's result; the drawer also says the worktree is gone.
  await expect.poll(() => row(page, SAMPLE_DONE).innerText(), { message: "the list row" }).toContain("pull request opened");
  await screenshot("finish-2-discarded");
});

/** Plain git in the fixture repo, without the developer's config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

const TEMPLATE = parseTemplateRecord({
  schemaVersion: 1,
  ref: "builtin/quick-fix",
  id: "quick-fix",
  source: { kind: "builtin" },
  name: "Quick fix",
  uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
  start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
  steps: [
    { id: "fix", name: "Fix", agentId: "builder", instructions: { text: "Fix it." }, doneWhen: "agent finishes", ifFailed: { action: "ask" }, maxAttempts: 1, data: "none", sees: [], connections: [], commands: [] },
  ],
  finish: ["commit"],
});

const MERGE_TITLE = "Fix the greeting typo";
const DISCARD_TITLE = "Rename the notes file";

/** A repo, its repos.yaml entry, and two done items with a commit each on their worktree branch. */
function seedRepo(home: string, tmp: string): string {
  const repo = join(realpathSync(tmp), "orders-api");
  mkdirSync(repo);
  writeFileSync(join(repo, "greeting.txt"), "helo world\n");
  writeFileSync(join(repo, "notes.txt"), "one\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, ".git", "info", "exclude"), "/.tokama/wt/\n");
  const tokamaHome = join(home, ".tokama");
  mkdirSync(tokamaHome, { recursive: true });
  writeFileSync(join(tokamaHome, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${repo}\n    base_branch: main\n`);
  if (!TEMPLATE.ok) throw new Error("the fixture template does not parse");
  const hostId = loadHostId(tokamaHome);
  if (!hostId.ok) throw new Error(hostId.error);
  const { store } = ItemStore.open({ home: tokamaHome, hostId: hostId.value });
  const base = git(repo, "rev-parse", "HEAD");
  for (const [title, file, text] of [
    [MERGE_TITLE, "greeting.txt", "hello world\n"],
    [DISCARD_TITLE, "notes.txt", "two\n"],
  ] as const) {
    const created = store.create({ template: TEMPLATE.value, title, text: title, repoIds: ["orders-api" as RepoId] });
    if (!created.ok) throw new Error(created.error.message);
    const short = created.value.id.slice(-8);
    const dir = `.tokama/wt/${short}`;
    git(repo, "worktree", "add", "-q", "-b", `tokama/${short}`, dir, "main");
    writeFileSync(join(repo, dir, file), text);
    git(join(repo, dir), "commit", "-q", "-am", `tokama: ${title}`);
    const commit = git(join(repo, dir), "rev-parse", "HEAD");
    const ended = store.append(created.value.id, [
      { type: "worktree_added", repoId: "orders-api" as RepoId, branch: `tokama/${short}`, dir, baseCommit: base },
      { type: "item_ended", outcome: "done", detail: "Committed.", commits: [{ repoId: "orders-api" as RepoId, commit }] },
    ]);
    if (!ended.ok) throw new Error(ended.error.message);
  }
  return repo;
}

let repoPath = "";

flow(
  "merges one done item into main and discards another, in a real repo",
  async ({ page }) => {
    await segment(page, "Done").click();
    await page.locator(".range").selectOption("30d");

    await row(page, MERGE_TITLE).click();
    let finish = drawer(page).locator(".finish");
    await finish.getByRole("button", { name: "Merge into main" }).click();
    await expect.poll(() => finish.innerText(), { message: "the merged line", timeout: 20_000 }).toMatch(/Merged into main · [0-9a-f]{7}/);
    expect(git(repoPath, "show", "main:greeting.txt")).toBe("hello world");
    expect(git(repoPath, "status", "--porcelain")).toBe("");
    // Only the other item's worktree and branch are left.
    expect(git(repoPath, "worktree", "list").split("\n").filter((line) => line.includes(".tokama/wt"))).toHaveLength(1);
    expect(git(repoPath, "branch", "--list", "tokama/*").split("\n").filter(Boolean)).toHaveLength(1);

    await row(page, DISCARD_TITLE).click();
    await drawer(page).getByRole("heading", { name: DISCARD_TITLE }).waitFor();
    finish = drawer(page).locator(".finish");
    // The merge moved main on; this branch still starts from the old main and is thrown away.
    await finish.getByRole("button", { name: "Discard" }).click();
    await finish.getByRole("group", { name: "Discard" }).getByRole("button", { name: "Discard" }).click();
    await expect.poll(() => finish.innerText(), { message: "the discarded line", timeout: 20_000 }).toContain("Discarded: the worktree and branch are removed.");
    expect(git(repoPath, "branch", "--list", "tokama/*")).toBe("");
    expect(existsSync(join(repoPath, ".tokama", "wt"))).toBe(true);
    expect(git(repoPath, "show", "main:notes.txt")).toBe("one");
  },
  "real",
  (home, tmp) => {
    repoPath = seedRepo(home, tmp);
  },
);
