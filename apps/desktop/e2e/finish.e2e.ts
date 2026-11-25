// Finishing a done item from the drawer: Open PR and Discard on the sample engine, and Merge and
// Discard on the real engine with a temp repo. The real flow seeds the Tokama home before the app
// starts: a repo, and two done items whose commits sit on their own worktree branches, as the run
// loop leaves them. No remote is touched.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Agent,
  type AgentRuntime,
  createGit,
  createProcessRunner,
  createRunLoop,
  ItemStore,
  loadHostId,
  parseTemplateRecord,
  posixProcessTable,
  type RepoId,
  systemClock,
} from "@tokama/core";
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

const template = (file: string) =>
  parseTemplateRecord({
    schemaVersion: 1,
    ref: "builtin/quick-fix",
    id: "quick-fix",
    source: { kind: "builtin" },
    name: "Quick fix",
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    steps: [
      { id: "fix", name: "Fix", agentId: "builder", instructions: { text: `Edit ${file}.` }, doneWhen: "agent finishes", ifFailed: { action: "ask" }, maxAttempts: 1, data: "repo-and-diff", sees: [], connections: [], commands: [] },
    ],
    finish: ["commit"],
  });

const MERGE_TITLE = "Fix the greeting typo";
const DISCARD_TITLE = "Rename the notes file";
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** An agent runtime that writes one file per call, by the item's title, and ends. */
const scripted = (writes: Record<string, [string, string]>): AgentRuntime => ({
  async *launch(request) {
    yield { type: "started", pid: 4242 };
    const write = Object.entries(writes).find(([title]) => request.prompt.includes(title))?.[1];
    if (write !== undefined) writeFileSync(join(request.cwd, write[0]), write[1]);
    yield { type: "end", outcome: "completed", usage: NO_TOKENS };
  },
});

/**
 * A repo, its repos.yaml entry, and two done items made by the real run loop with a scripted
 * agent: each has its worktree, its commit on the item branch and its steering baseline, as a
 * real run leaves them.
 */
async function seedRepo(home: string, tmp: string): Promise<string> {
  const repo = join(realpathSync(tmp), "orders-api");
  mkdirSync(repo);
  writeFileSync(join(repo, "greeting.txt"), "helo world\n");
  writeFileSync(join(repo, "notes.txt"), "one\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  const tokamaHome = join(home, ".tokama");
  mkdirSync(tokamaHome, { recursive: true });
  writeFileSync(join(tokamaHome, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${repo}\n    base_branch: main\n`);
  const hostId = loadHostId(tokamaHome);
  if (!hostId.ok) throw new Error(hostId.error);
  const { store } = ItemStore.open({ home: tokamaHome, hostId: hostId.value });
  const runner = createProcessRunner();
  const config = { id: "orders-api" as RepoId, path: repo, baseBranch: "main", worktreeFolder: ".tokama/wt", checks: [] };
  const agent: Agent = { id: "builder" as never, name: "Builder", cliId: "claude-code", model: "haiku", limits: { edit: true, commands: [], web: false }, role: "Builder.", owner: { kind: "builtin" } };
  const loop = createRunLoop({
    store,
    git: createGit({ runner }),
    runner,
    clock: systemClock,
    processes: posixProcessTable,
    repo: (id) => (id === config.id ? config : undefined),
    agent: () => agent,
    runtime: () => scripted({ [MERGE_TITLE]: ["greeting.txt", "hello world\n"], [DISCARD_TITLE]: ["notes.txt", "two\n"] }),
  });
  for (const [title, file] of [[MERGE_TITLE, "greeting.txt"], [DISCARD_TITLE, "notes.txt"]] as const) {
    const parsed = template(file);
    if (!parsed.ok) throw new Error("the fixture template does not parse");
    const started = await loop.startItem({ template: parsed.value, repoId: config.id, text: title });
    if (!started.ok) throw new Error(started.error.message);
    await loop.settled(started.value);
    if (store.get(started.value)?.state !== "done") throw new Error(`the seeded item did not end done: ${JSON.stringify(store.get(started.value)?.outcome)}`);
  }
  await loop.close();
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
  async (home, tmp) => {
    repoPath = await seedRepo(home, tmp);
  },
);
