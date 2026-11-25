// Finishing a done item from the drawer and from its Done row: Open PR and Discard on the sample
// engine, and Merge and Discard on the real engine with a temp repo. The real flow seeds the Tokama home before the app
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

flow("opens a pull request for a done item from the row's menu, then removes its worktree after a confirmation", async ({ page, screenshot }) => {
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  const line = row(page, SAMPLE_DONE).locator("xpath=..");
  await line.hover();
  const split = line.locator(".finish-split");
  expect(await split.locator(".finish-split-main").innerText()).toBe("Merge into main");
  await split.getByRole("button", { name: `More ways to finish ${SAMPLE_DONE}` }).click();
  const menu = split.getByRole("menu");
  expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Merge into main\nlocal merge, then clean up", "Open PR\npush and open with gh", "Discard…"]);
  await screenshot("finish-2-row-menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  await row(page, SAMPLE_DONE).click();
  const finish = drawer(page).locator(".finish");
  await finish.waitFor();
  expect((await finish.locator(".finish-head").innerText()).replace(/\s+/g, " ")).toBe("FINISH tokama/00000011 · 1 commit ahead of main");
  expect(await finish.locator(".finish-row .choice").allTextContents()).toEqual(["Merge into main", "Open PR", "Discard…"]);
  expect(await finish.locator(".finish-row").nth(1).innerText()).toContain("Pushes tokama/00000011 to github.com/northwind/orders-api and opens a pull request with gh.");
  await screenshot("finish-1-offered");

  await finish.getByRole("button", { name: "Discard…" }).click();
  await finish.getByRole("group", { name: "Discard this work?" }).waitFor();
  await screenshot("finish-3-discard-question");
  await finish.getByRole("button", { name: "Keep" }).click();

  await finish.getByRole("button", { name: "Open PR" }).click();
  const ended = drawer(page).locator(".finish-ended");
  await expect.poll(() => ended.innerText().catch(() => ""), { message: "the pull request end" }).toContain("PR #128 open");
  expect(await ended.innerText()).toContain("https://github.com/northwind/orders-api/pull/128");
  expect(await drawer(page).locator(".drawer-state").innerText()).toContain("PR open");
  await expect.poll(() => row(page, SAMPLE_DONE).innerText(), { message: "the list row" }).toContain("PR #128 open");
  await screenshot("finish-4-pr-open");

  await ended.getByRole("button", { name: "Remove worktree" }).click();
  await ended.getByRole("group", { name: "Discard this work?" }).getByRole("button", { name: "Discard" }).click();
  await expect.poll(() => ended.innerText(), { message: "the worktree removed" }).toContain("Worktree and branch removed");
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
  "merges one done item into main from its row and discards another, in a real repo",
  async ({ page, screenshot }) => {
    await segment(page, "Done").click();
    await page.locator(".range").selectOption("30d");

    // A checkout on another branch: Merge is refused in place, and nothing moves.
    git(repoPath, "switch", "-q", "-c", "feature/login");
    await row(page, MERGE_TITLE).click();
    const offer = drawer(page).locator(".finish");
    await offer.getByRole("button", { name: "Merge into main" }).click();
    await expect.poll(() => offer.locator(".finish-notice").innerText().catch(() => ""), { message: "the refusal", timeout: 20_000 }).toContain("Your checkout is on another branch.");
    expect(await offer.locator(".finish-notice").innerText()).toContain("Your checkout is on feature/login, not main.");
    expect(await offer.locator(".finish-row").first().getByRole("button").innerText()).toBe("Try again");
    await screenshot("finish-7-refused-other-branch");
    git(repoPath, "switch", "-q", "main");
    await drawer(page).getByRole("button", { name: "Close" }).click();

    // Merge from the Done row's split button.
    const line = row(page, MERGE_TITLE).locator("xpath=..");
    await line.hover();
    await line.locator(".finish-split-main").click();
    await expect.poll(() => row(page, MERGE_TITLE).innerText(), { message: "the merged row", timeout: 20_000 }).toMatch(/Merged into main · [0-9a-f]{7}/);
    expect(git(repoPath, "show", "main:greeting.txt")).toBe("hello world");
    expect(git(repoPath, "status", "--porcelain")).toBe("");
    // Only the other item's worktree and branch are left.
    expect(git(repoPath, "worktree", "list").split("\n").filter((entry) => entry.includes(".tokama/wt"))).toHaveLength(1);
    expect(git(repoPath, "branch", "--list", "tokama/*").split("\n").filter(Boolean)).toHaveLength(1);
    await row(page, MERGE_TITLE).click();
    await expect.poll(() => drawer(page).locator(".finish-ended").innerText(), { message: "the merged end" }).toMatch(/Merged into main · [0-9a-f]{7} · \d\d:\d\d\s+Worktree and branch removed/);
    await screenshot("finish-5-merged");

    await row(page, DISCARD_TITLE).click();
    await drawer(page).getByRole("heading", { name: DISCARD_TITLE }).waitFor();
    const finish = drawer(page).locator(".finish");
    // The merge moved main on; this branch still starts from the old main and is thrown away.
    await finish.getByRole("button", { name: "Discard…" }).click();
    await finish.getByRole("group", { name: "Discard this work?" }).getByRole("button", { name: "Discard" }).click();
    await expect.poll(() => drawer(page).locator(".finish-ended").innerText().catch(() => ""), { message: "the discarded end", timeout: 20_000 }).toContain("Discarded");
    expect(await drawer(page).locator(".drawer-state").innerText()).toContain("discarded");
    await screenshot("finish-6-discarded");
    expect(git(repoPath, "branch", "--list", "tokama/*")).toBe("");
    expect(existsSync(join(repoPath, ".tokama", "wt"))).toBe(true);
    expect(git(repoPath, "show", "main:notes.txt")).toBe("one");
  },
  "real",
  async (home, tmp) => {
    repoPath = await seedRepo(home, tmp);
  },
);
