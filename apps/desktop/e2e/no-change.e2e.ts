// "No change needed" on the real engine: a plan step whose agent says so (and changed no file) asks
// "No change needed. Finish with this answer?". Finish ends the item with its answer, 0 files, and
// removes its worktree; Build anyway needs a note and runs the plan step again. The Tokama home is
// seeded before the app starts with two Plan and build items made by the real run loop and a
// scripted agent that answers with NO_CHANGE: yes; both wait at the card.
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

const FINISHED = "How hard is it to add CSV export to orders?";
const BUILT = "Is CSV export worth adding to orders?";
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ANSWER = [
  "About half a day. The list query already streams its rows.",
  "",
  "HEADLINE: About half a day: the list query already streams, so export is one new endpoint and one test file.",
  "POINT: 4 files in orders-api would change, no database change",
  "POINT: Main risk: memory on ranges over 31 days",
  "NO_CHANGE: yes",
].join("\n");

/** Plain git in the fixture repo, without the developer's config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

/** An agent runtime that only answers: it changes no file. */
const answering = (): AgentRuntime => ({
  async *launch() {
    yield { type: "started", pid: 4242 };
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
  const config = { id: "orders-api" as RepoId, path: repo, baseBranch: "main", worktreeFolder: ".tokama/wt", checks: ["pnpm test"] };
  const agent: Agent = { id: "architect" as never, name: "Architect", cliId: "claude-code", model: "opus", limits: { edit: true, commands: [], web: false }, role: "Architect.", owner: { kind: "builtin" } };
  const loads = await loadBuiltins(new Map([["architect", { cloud: true }], ["builder", { cloud: true }], ["reviewer", { cloud: true }]]));
  const planAndBuild = loads.find((load) => load.ok && load.template.id === "plan-and-build");
  if (!planAndBuild?.ok) throw new Error("the built-in Plan and build template does not load");
  const loop = createRunLoop({
    store,
    git: createGit({ runner }),
    runner,
    clock: systemClock,
    processes: posixProcessTable,
    repo: (id) => (id === config.id ? config : undefined),
    agent: () => agent,
    runtime: () => answering(),
  });
  for (const text of [FINISHED, BUILT]) {
    const started = await loop.startItem({ template: planAndBuild.template, repoId: config.id, text });
    if (!started.ok) throw new Error(started.error.message);
    await loop.settled(started.value);
    const item = store.get(started.value);
    if (item?.state !== "needs_you" || item.decisions[0]?.proposes !== "no_change") throw new Error(`the seeded item did not ask to finish: ${JSON.stringify(item?.decisions)}`);
  }
  await loop.close();
  return repo;
}

let repoPath = "";

flow(
  "No change needed: the card proposes finishing, Finish ends the item with its answer and removes the worktree, Build anyway needs a note",
  async ({ page, screenshot }) => {
    await segment(page, "Needs you").click();
    await row(page, FINISHED).waitFor();
    // Both worktrees exist while the cards wait.
    expect(git(repoPath, "worktree", "list").split("\n").filter((entry) => entry.includes(".tokama/wt"))).toHaveLength(2);

    await openRow(page, FINISHED);
    const card = drawer(page).locator(".needs-you");
    await card.waitFor();
    expect(await card.locator(".needs-you-question").innerText()).toContain("No change needed. Finish with this answer?");
    expect(await card.locator(".choices .btn").allInnerTexts()).toEqual(["Finish, keep the answer", "Build anyway…", "Stop"]);
    expect(await card.locator(".rc-row").allInnerTexts()).toEqual(["Then\nThe item ends as done · Build and Review do not run", "Changes\nnone · 0 files changed, nothing is committed"]);
    expect(await card.locator(".said-line").innerText()).toContain("About half a day: the list query already streams");
    await screenshot("no-change-1-card");

    // Build anyway: the note is required, and it goes back to the same step.
    await drawer(page).getByRole("button", { name: "Close" }).click();
    await openRow(page, BUILT);
    const second = drawer(page).locator(".needs-you");
    await second.getByRole("button", { name: "Build anyway…" }).click();
    expect(await second.locator("label").innerText()).toBe("What should be built?");
    const send = second.getByRole("button", { name: "Send and plan" });
    expect(await send.isDisabled()).toBe(true);
    await second.locator("textarea").fill("Yes, add it. CSV only, 31 days at most.");
    expect(await send.isDisabled()).toBe(false);
    await screenshot("no-change-2-build-anyway");
    await send.click();
    // The plan step runs again; nothing was built or committed and the first item still waits.
    await drawer(page).locator(".drawer-state").getByText("running").waitFor();
    expect(git(repoPath, "log", "--format=%s", "main")).toBe("seed");
    await drawer(page).getByRole("button", { name: "Close" }).click();

    // Finish: done with its answer, the worktree and branch removed, nothing committed.
    await openRow(page, FINISHED);
    await card.getByRole("button", { name: "Finish, keep the answer" }).click();
    const result = drawer(page).locator(".result-card");
    await result.waitFor();
    expect(await result.locator(".rc-label").textContent()).toBe("Done · no change needed");
    expect(await result.locator(".rc-headline").innerText()).toBe("About half a day: the list query already streams, so export is one new endpoint and one test file.");
    // The worktree is removed right after the item ends: the card says so once that is recorded.
    await expect
      .poll(async () => (await result.locator(".rc-row").allInnerTexts()).slice(0, 2), { message: "the Changed and Ran rows" })
      .toEqual(["Changed\nnone · 0 files changed, nothing committed · the worktree is removed", "Ran\nPlan only · Build and Review did not run"]);
    expect((await result.locator(".rc-row").allInnerTexts())[2]).toMatch(/^Sent out/);
    await result.getByRole("button", { name: "Read the answer" }).waitFor();
    await result.getByRole("button", { name: "Start work from this…" }).waitFor();
    await drawer(page).locator(".finish-ended-title").getByText("Nothing committed").waitFor();
    expect(await drawer(page).getByRole("button", { name: "Discard…" }).count()).toBe(0);
    expect(git(repoPath, "worktree", "list").split("\n").filter((entry) => entry.includes(".tokama/wt"))).toHaveLength(1);
    expect(git(repoPath, "branch", "--list", "tokama/*").split("\n").filter(Boolean)).toHaveLength(1);
    expect(git(repoPath, "log", "--format=%s", "main")).toBe("seed");
    await screenshot("no-change-3-result-card");

    await drawer(page).getByRole("button", { name: "Close" }).click();
    await segment(page, "Done").click();
    await page.locator(".range").selectOption("30d");
    const line = row(page, FINISHED);
    await line.waitFor();
    const text = await line.innerText();
    expect(text).toContain("no change needed · ended at Plan, step 1 of 3");
    expect(text).toContain("0 files");
    expect(text).toContain("About half a day: the list query already streams");
    await screenshot("no-change-3-row");

    await drawer(page).waitFor({ state: "detached" });
    await openRow(page, FINISHED);
    await drawer(page).locator(".result-card").getByRole("button", { name: "Start work from this…" }).click();
    await expect.poll(() => page.locator("textarea.np-text").inputValue(), { message: "the New work text" }).toContain(`${FINISHED}\n\nThe answer: About half a day`);
  },
  "real",
  async (home, tmp) => {
    repoPath = await seedRepo(home, tmp);
    // New work only opens while an AI CLI is ready.
    setClaude(tmp, "ready");
  },
  { env: fakeToolsEnv },
);
