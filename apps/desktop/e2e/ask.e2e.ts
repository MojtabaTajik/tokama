// Ask on the real engine: the built-in Ask template is listed first among the read-only ones, an
// Ask item ends done with its answer, a reader link and no worktree, and "Start work from this…"
// opens New work with the question and the answer. The Tokama home is seeded before the app starts
// with two Ask items made by the real run loop and a scripted agent: one that only answers, and
// one that writes a file anyway (nothing is committed and its worktree is kept).
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Agent,
  type AgentRuntime,
  createGit,
  createProcessRunner,
  createRunLoop,
  ItemStore,
  loadBuiltins,
  loadHostId,
  posixProcessTable,
  type RepoId,
  systemClock,
} from "@tokama/core";
import { expect } from "vitest";
import { fakeToolsEnv, setClaude } from "./fake-tools.js";
import { drawer, flow, openRow, row, segment } from "./harness.js";

const ANSWERED = "How hard is it to add CSV export to orders?";
const STRAY = "Why does the nightly export skip refunds?";
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ANSWER = [
  "About half a day. The list query already streams its rows.",
  "",
  "- src/orders/list.ts returns a cursor.",
  "",
  "HEADLINE: About half a day: the list query already streams, so export is one new endpoint and one test file.",
  "POINT: 4 files in orders-api would change, no database change",
  "POINT: Main risk: memory on ranges over 31 days",
].join("\n");

/** Plain git in the fixture repo, without the developer's config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

/** An agent runtime that answers by the item's text; the second question also writes a file, which a read template must not keep. */
const scripted = (): AgentRuntime => ({
  async *launch(request) {
    yield { type: "started", pid: 4242 };
    if (request.prompt.includes(STRAY)) writeFileSync(join(request.cwd, "notes.txt"), "written anyway\n");
    yield { type: "text", text: ANSWER };
    yield { type: "end", outcome: "completed", usage: NO_TOKENS };
  },
});

async function seedRepo(home: string, tmp: string): Promise<string> {
  const repo = join(realpathSync(tmp), "orders-api");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.txt"), "orders\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  const tokamaHome = join(home, ".tokama");
  mkdirSync(tokamaHome, { recursive: true });
  writeFileSync(join(tokamaHome, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${repo}\n    base_branch: main\n`);
  const hostId = loadHostId(tokamaHome);
  if (!hostId.ok) throw new Error(hostId.error);
  const { store } = ItemStore.open({ home: tokamaHome, hostId: hostId.value });
  const runner = createProcessRunner();
  const config = { id: "orders-api" as RepoId, path: repo, baseBranch: "main", worktreeFolder: ".tokama/wt", checks: [] };
  const agent: Agent = { id: "architect" as never, name: "Architect", cliId: "claude-code", model: "opus", limits: { edit: true, commands: [], web: false }, role: "Architect.", owner: { kind: "builtin" } };
  const loads = await loadBuiltins(new Map([["architect", { cloud: true }], ["builder", { cloud: true }], ["reviewer", { cloud: true }]]));
  const ask = loads.find((load) => load.ok && load.template.id === "ask");
  if (!ask?.ok) throw new Error("the built-in Ask template does not load");
  const loop = createRunLoop({
    store,
    git: createGit({ runner }),
    runner,
    clock: systemClock,
    processes: posixProcessTable,
    repo: (id) => (id === config.id ? config : undefined),
    agent: () => agent,
    runtime: () => scripted(),
  });
  for (const text of [ANSWERED, STRAY]) {
    const started = await loop.startItem({ template: ask.template, repoId: config.id, text });
    if (!started.ok) throw new Error(started.error.message);
    await loop.settled(started.value);
    if (store.get(started.value)?.state !== "done") throw new Error(`the seeded item did not end done: ${JSON.stringify(store.get(started.value)?.outcome)}`);
  }
  await loop.close();
  return repo;
}

let repoPath = "";

flow(
  "Ask: lists first among the read-only templates, ends done with its answer and no worktree, and starts work from the answer",
  async ({ page, screenshot }) => {
    await segment(page, "Done").click();
    await page.locator(".range").selectOption("30d");

    // Nothing was committed: the answered item's worktree and branch are gone; the one that wrote a file keeps its worktree, and main has not moved.
    expect(git(repoPath, "worktree", "list").split("\n").filter((entry) => entry.includes(".tokama/wt"))).toHaveLength(1);
    expect(git(repoPath, "branch", "--list", "tokama/*").split("\n").filter(Boolean)).toHaveLength(1);
    expect(git(repoPath, "log", "--format=%s", "main")).toBe("seed");

    const line = row(page, ANSWERED);
    await line.waitFor();
    expect(await line.innerText()).toContain("About half a day: the list query already streams");
    await screenshot("ask-2-row");

    await openRow(page, ANSWERED);
    const card = drawer(page).locator(".result-card");
    await card.waitFor();
    expect(await card.locator(".rc-headline").innerText()).toBe("About half a day: the list query already streams, so export is one new endpoint and one test file.");
    expect(await card.locator(".rc-points li").allInnerTexts()).toEqual(["4 files in orders-api would change, no database change", "Main risk: memory on ranges over 31 days"]);
    expect(await drawer(page).locator(".finish-ended-title").innerText()).toContain("Nothing committed");
    await card.getByRole("button", { name: "Read the answer" }).waitFor();
    expect(await drawer(page).getByRole("button", { name: "Discard…" }).count()).toBe(0);
    await screenshot("ask-3-result-card");

    // The answer that wrote a file anyway: nothing committed, its worktree stays, and Discard… is the only way out.
    await drawer(page).getByRole("button", { name: "Close" }).click();
    await openRow(page, STRAY);
    await drawer(page).locator(".finish").getByRole("button", { name: "Discard…" }).waitFor();
    await drawer(page).getByRole("button", { name: "Close" }).click();

    await openRow(page, ANSWERED);
    await drawer(page).locator(".result-card").getByRole("button", { name: "Start work from this…" }).click();
    const text = page.locator("textarea.np-text");
    await expect.poll(() => text.inputValue(), { message: "the New work text" }).toBe(`${ANSWERED}\n\nThe answer: About half a day: the list query already streams, so export is one new endpoint and one test file.\n- 4 files in orders-api would change, no database change\n- Main risk: memory on ranges over 31 days`);
    expect(await page.locator(".np-trigger", { hasText: "Template" }).innerText()).toContain("Choose…");
    expect(await page.locator(".np-sample-label").count()).toBe(0);
    await page.locator(".np-trigger", { hasText: "Template" }).click();
    expect((await page.locator('.np-list [role="option"]').allTextContents()).map((entry) => entry.replace(/^✓/, ""))).toEqual(["Askread-only", "Review coderead-only", "Quick fixchanges code", "Quick changechanges code", "Plan and buildchanges code"]);
    await screenshot("ask-1-picker");
    await page.keyboard.press("Escape");
    // Nothing starts by itself.
    expect(await page.locator(".pl-row").count()).toBeGreaterThan(0);
    expect(git(repoPath, "branch", "--list", "tokama/*").split("\n").filter(Boolean)).toHaveLength(1);
  },
  "real",
  async (home, tmp) => {
    repoPath = await seedRepo(home, tmp);
    // New work only opens while an AI CLI is ready.
    setClaude(tmp, "ready");
  },
  { env: fakeToolsEnv },
);
