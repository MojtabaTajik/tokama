// Finish actions on a done item, against real temp repos: Merge (fast-forward, a clean merge,
// and every refusal), Open PR (a push to a temp bare remote, with a stub gh), Discard, and a
// restart while an action runs. No real remote or pull request is ever touched: origin names a
// GitHub URL that the repo's own `insteadOf` sends to the bare repo, and gh is a shell script.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import { TemplateRecordSchema, type FinishAction, type HostId, type ItemId, type RepoId, type StoredItem } from "../../kernel/schemas/index.js";
import type { Repo } from "../config/index.js";
import { ItemStore } from "../items/index.js";
import { commitItem, createWorktree, originPushUrl, stageItem, worktreePath } from "../worktrees/index.js";
import { createFinisher, type FinishDeps } from "./finish.js";

const SLOW = { timeout: 30_000 };
const HOST = "host_0190a000-0000-7000-8000-000000000001" as HostId;
const ORIGIN = "https://github.com/acme/orders-api.git";
const PR_URL = "https://github.com/acme/orders-api/pull/7";

let root: string;
let repo: Repo;
let home: string;
let bare: string;
let ghDir: string;
let git: Git;
let store: ItemStore;

const TEMPLATE = TemplateRecordSchema.parse({
  schemaVersion: 1,
  ref: "orders-api/quick-fix",
  id: "quick-fix",
  source: { kind: "repo", repoId: "orders-api", file: ".tokama/templates/quick-fix.yaml" },
  name: "Quick fix",
  uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
  start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
  steps: [
    { id: "build", name: "build", agentId: "builder", instructions: { text: "Build." }, doneWhen: "agent finishes", ifFailed: { action: "ask" }, maxAttempts: 1, data: "none", sees: [], connections: [], commands: [] },
  ],
  finish: ["commit"],
});

/** Plain git for fixtures and assertions; the developer's own config is not read. Resolves to stdout, trimmed. */
async function tryGit(cwd: string, ...args: string[]): Promise<{ code: number | null; out: string; error: string }> {
  const out: string[] = [];
  const error: string[] = [];
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: root } });
  const result = await runner.run({
    command: { argv: ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args] },
    cwd,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: { onLine: (line) => out.push(line) },
    stderr: { onLine: (line) => error.push(line) },
  });
  return { code: result.kind === "finished" ? result.exitCode : null, out: out.join("\n").trim(), error: error.join("\n") };
}
async function plain(cwd: string, ...args: string[]): Promise<string> {
  const run = await tryGit(cwd, ...args);
  if (run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.error}`);
  return run.out;
}

const STUB_GH = `#!/bin/sh
dir=$(dirname "$0")
{ printf 'cwd=%s\\n' "$(pwd)"; for arg in "$@"; do printf '%s\\n' "$arg"; done; printf -- '--\\n'; } >> "$dir/calls.log"
mode=$(cat "$dir/mode" 2>/dev/null)
case "$1" in
  --version) echo "gh version 2.105.0"; exit 0 ;;
  auth) [ "$mode" = "logged-out" ] && { echo "not logged in" >&2; exit 1; }; exit 0 ;;
  api)
    case "$*" in
      *"--method POST"*)
        if [ "$mode" = "exists" ]; then echo '{"message":"Validation Failed"}'; echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
        if [ "$mode" = "logged-out" ]; then echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2; exit 4; fi
        echo "${PR_URL}"; exit 0 ;;
      *"--method GET"*)
        [ "$mode" = "exists" ] && echo "https://github.com/acme/orders-api/pull/3"; exit 0 ;;
    esac ;;
esac
exit 1
`;

const ghCalls = () => (existsSync(join(ghDir, "calls.log")) ? readFileSync(join(ghDir, "calls.log"), "utf8") : "");
const ghMode = (mode: string) => writeFileSync(join(ghDir, "mode"), mode);

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pr-55-finish-")));
  const path = join(root, "orders-api");
  home = join(root, "home");
  bare = join(root, "remote.git");
  ghDir = join(root, "gh");
  mkdirSync(path);
  mkdirSync(ghDir);
  writeFileSync(join(ghDir, "gh"), STUB_GH);
  chmodSync(join(ghDir, "gh"), 0o755);
  writeFileSync(join(path, "greeting.txt"), "helo world\n");
  writeFileSync(join(path, "notes.txt"), "one\n");
  await plain(path, "init", "-q", "-b", "main");
  await plain(path, "add", "-A");
  await plain(path, "commit", "-q", "-m", "seed");
  await plain(path, "config", "user.name", "Test");
  await plain(path, "config", "user.email", "test@example.com");
  await plain(root, "init", "-q", "--bare", bare);
  await plain(path, "remote", "add", "origin", ORIGIN);
  await plain(path, "config", `url.${bare}.insteadOf`, ORIGIN);
  repo = { id: "orders-api" as RepoId, path, baseBranch: "main", worktreeFolder: ".tokama/wt", checks: [] };
  git = createGit({ runner: createProcessRunner() });
  store = ItemStore.open({ home, hostId: HOST }).store;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A done item whose agent wrote `files` in its worktree, committed by Tokama as the run loop does. */
async function doneItem(files: Record<string, string> = { "greeting.txt": "hello world\n" }): Promise<StoredItem> {
  const created = store.create({ template: TEMPLATE, title: "Fix the greeting typo", text: "Fix the greeting", repoIds: [repo.id] });
  if (!created.ok) throw new Error(created.error.message);
  const id = created.value.id;
  const worktree = await createWorktree(git, repo, id);
  if (!worktree.ok) throw new Error(worktree.error.message);
  const path = worktreePath(repo.path, worktree.value);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
  const tree = await stageItem(git, path);
  if (!tree.ok) throw new Error(tree.error.message);
  const commit = await commitItem(git, path, worktree.value, { id, title: "Fix the greeting typo", tree: tree.value });
  if (!commit.ok) throw new Error(commit.error.message);
  const pushUrl = await originPushUrl(git, repo.path);
  const { branch, folder, baseCommit } = worktree.value;
  const ended = store.append(id, [
    { type: "worktree_added", repoId: repo.id, branch, dir: folder, baseCommit, ...(pushUrl.ok && pushUrl.value !== undefined && { pushUrl: pushUrl.value }) },
    { type: "item_ended", outcome: "done", detail: "Committed.", commits: [{ repoId: repo.id, commit: commit.value }] },
  ]);
  if (!ended.ok) throw new Error(ended.error.message);
  return ended.value;
}

function finisher(extra: Partial<FinishDeps> = {}) {
  return createFinisher({ store, git, runner: createProcessRunner(), repo: (id) => (id === repo.id ? repo : undefined), ghCommand: [join(ghDir, "gh")], ...extra });
}

/** Starts the action and waits for its result. */
async function run(item: StoredItem, action: FinishAction, deps: Partial<FinishDeps> = {}): Promise<StoredItem> {
  const finish = finisher(deps);
  const started = finish.start(item.id, action);
  if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
  await finish.settled(item.id);
  return store.get(item.id)!;
}

const commitOf = (item: StoredItem) => item.outcome!.commits![0]!.commit;
const wtPath = (item: StoredItem) => join(repo.path, ...item.worktrees[0]!.dir.split("/"));
const branchExists = async (branch: string) => (await tryGit(repo.path, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)).code === 0;
const lastEvents = (item: StoredItem, n: number) =>
  readFileSync(join(home, "items", item.id, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .slice(-n)
    .map((line) => JSON.parse(line) as { type: string });

describe("Merge", () => {
  it("fast-forwards the base branch to the item's commit, then removes the worktree and branch", SLOW, async () => {
    const item = await doneItem();
    const done = await run(item, "merge");
    expect(done.finish).toMatchObject({ merged: { baseBranch: "main", commit: commitOf(item) }, worktreeRemoved: true });
    expect(done.finish?.running).toBeUndefined();
    expect(await plain(repo.path, "rev-parse", "main")).toBe(commitOf(item));
    expect(readFileSync(join(repo.path, "greeting.txt"), "utf8")).toBe("hello world\n");
    expect(existsSync(wtPath(item))).toBe(false);
    expect(await branchExists(item.worktrees[0]!.branch)).toBe(false);
    expect(lastEvents(done, 2).map((e) => e.type)).toEqual(["finish_started", "merged"]);
  });

  it("makes a merge commit when the base branch moved on without conflicts", SLOW, async () => {
    const item = await doneItem();
    writeFileSync(join(repo.path, "notes.txt"), "two\n");
    await plain(repo.path, "commit", "-q", "-am", "notes on main");
    const before = await plain(repo.path, "rev-parse", "main");
    const done = await run(item, "merge");
    const merge = await plain(repo.path, "rev-parse", "main");
    expect(done.finish?.merged?.commit).toBe(merge);
    expect((await plain(repo.path, "rev-list", "--parents", "-n", "1", merge)).split(" ").slice(1)).toEqual([before, commitOf(item)]);
    expect(await plain(repo.path, "log", "-1", "--format=%B", merge)).toContain(`Tokama-Item: ${item.id}`);
    expect(readFileSync(join(repo.path, "greeting.txt"), "utf8")).toBe("hello world\n");
    expect(readFileSync(join(repo.path, "notes.txt"), "utf8")).toBe("two\n");
    expect(await plain(repo.path, "status", "--porcelain")).toBe("");
    expect(done.finish?.worktreeRemoved).toBe(true);
  });

  it("refuses a checkout with uncommitted changes and leaves it untouched", SLOW, async () => {
    const item = await doneItem();
    writeFileSync(join(repo.path, "notes.txt"), "mine, not committed\n");
    const done = await run(item, "merge");
    expect(done.finish?.failed).toMatchObject({ action: "merge" });
    expect(done.finish?.failed?.detail).toMatch(/uncommitted changes \(notes\.txt\).*never stashes/);
    expect(readFileSync(join(repo.path, "notes.txt"), "utf8")).toBe("mine, not committed\n");
    expect(await plain(repo.path, "rev-parse", "main")).toBe(item.worktrees[0]!.baseCommit);
    expect(await plain(repo.path, "stash", "list")).toBe("");
    expect(existsSync(wtPath(item))).toBe(true);
    expect(done.finish?.worktreeRemoved).toBe(false);
  });

  it("refuses a checkout on another branch and does not switch it", SLOW, async () => {
    const item = await doneItem();
    await plain(repo.path, "switch", "-q", "-c", "feature");
    const done = await run(item, "merge");
    expect(done.finish?.failed?.detail).toBe("Your checkout is on feature, not main. Switch it to main, then merge again. Tokama does not switch branches for you.");
    expect(await plain(repo.path, "branch", "--show-current")).toBe("feature");
    expect(await plain(repo.path, "rev-parse", "main")).toBe(item.worktrees[0]!.baseCommit);
  });

  it("refuses a conflict, names the files, and changes nothing", SLOW, async () => {
    const item = await doneItem();
    writeFileSync(join(repo.path, "greeting.txt"), "hi world\n");
    await plain(repo.path, "commit", "-q", "-am", "conflicting greeting");
    const before = await plain(repo.path, "rev-parse", "main");
    const done = await run(item, "merge");
    expect(done.finish?.failed?.detail).toMatch(/^The branch conflicts with main in greeting\.txt\./);
    expect(await plain(repo.path, "rev-parse", "main")).toBe(before);
    expect(await plain(repo.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo.path, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("refuses when an untracked file in the checkout would be overwritten", SLOW, async () => {
    const item = await doneItem({ "greeting.txt": "hello world\n", "new.txt": "from the agent\n" });
    writeFileSync(join(repo.path, "new.txt"), "my own file\n");
    const done = await run(item, "merge");
    expect(done.finish?.failed?.detail).toMatch(/would overwrite/);
    expect(done.finish?.failed?.detail).not.toContain(root);
    expect(readFileSync(join(repo.path, "new.txt"), "utf8")).toBe("my own file\n");
    expect(await plain(repo.path, "rev-parse", "main")).toBe(item.worktrees[0]!.baseCommit);
  });

  it("keeps a worktree that has files outside the commit, and Discard still removes it", SLOW, async () => {
    const item = await doneItem();
    writeFileSync(join(wtPath(item), "coverage.txt"), "written after the commit\n");
    const merged = await run(item, "merge");
    expect(merged.finish).toMatchObject({ merged: { commit: commitOf(item) }, worktreeRemoved: false });
    expect(merged.finish?.detail).toMatch(/worktree was kept/);
    expect(existsSync(wtPath(item))).toBe(true);
    const discarded = await run(merged, "discard");
    expect(discarded.finish?.worktreeRemoved).toBe(true);
    expect(existsSync(wtPath(item))).toBe(false);
    expect(await branchExists(item.worktrees[0]!.branch)).toBe(false);
  });

  it("runs two merges on one repo one after the other: the second becomes a merge commit on the first", SLOW, async () => {
    const first = await doneItem();
    const second = await doneItem({ "notes.txt": "two\n" });
    const finish = finisher();
    expect(finish.start(first.id, "merge").ok).toBe(true);
    expect(finish.start(second.id, "merge").ok).toBe(true);
    await Promise.all([finish.settled(first.id), finish.settled(second.id)]);
    expect(store.get(first.id)?.finish?.merged?.commit).toBe(commitOf(first));
    const merge = store.get(second.id)!.finish!.merged!.commit;
    expect((await plain(repo.path, "rev-list", "--parents", "-n", "1", merge)).split(" ").slice(1)).toEqual([commitOf(first), commitOf(second)]);
    expect(await plain(repo.path, "rev-parse", "main")).toBe(merge);
    expect(await plain(repo.path, "status", "--porcelain")).toBe("");
  });

  it("keeps Discard on offer when the branch had commits that were not merged", SLOW, async () => {
    const item = await doneItem();
    // main has the item's commit already; the engineer committed on the item branch after Done.
    await plain(repo.path, "merge", "-q", "--ff-only", commitOf(item));
    writeFileSync(join(wtPath(item), "extra.txt"), "later\n");
    await plain(wtPath(item), "add", "extra.txt");
    await plain(wtPath(item), "commit", "-q", "-m", "later");
    const merged = await run(item, "merge");
    expect(merged.finish).toMatchObject({ merged: { commit: commitOf(item) }, worktreeRemoved: false });
    expect(merged.finish?.detail).toMatch(/branch tokama\/[0-9a-f]{8} was kept/);
    expect((await run(merged, "discard")).finish?.worktreeRemoved).toBe(true);
    expect(await branchExists(item.worktrees[0]!.branch)).toBe(false);
  });

  it("close() refuses new actions", SLOW, async () => {
    const item = await doneItem();
    const finish = finisher();
    await finish.close();
    expect(finish.start(item.id, "discard")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(store.get(item.id)?.finish).toBeUndefined();
  });

  it("refuses a second merge and an action on an item that is not done", SLOW, async () => {
    const item = await doneItem();
    const merged = await run(item, "merge");
    expect(finisher().start(merged.id, "merge")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(finisher().start(merged.id, "discard")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const running = store.create({ template: TEMPLATE, title: "Still running", text: "x", repoIds: [repo.id] });
    if (!running.ok) throw new Error(running.error.message);
    expect(finisher().start(running.value.id, "discard")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });
});

describe("Open PR", () => {
  it("pushes the commit to the bare remote and records the URL gh gives, outside the repo", SLOW, async () => {
    const item = await doneItem();
    expect(item.worktrees[0]?.pushUrl).toBe(ORIGIN);
    const done = await run(item, "pull_request");
    expect(done.finish).toMatchObject({ pullRequest: { url: PR_URL }, worktreeRemoved: false });
    const branch = item.worktrees[0]!.branch;
    expect(await plain(bare, "rev-parse", `refs/heads/${branch}`)).toBe(commitOf(item));
    const calls = ghCalls();
    expect(calls).toContain(["api", "--hostname", "github.com", "--method", "POST", "repos/acme/orders-api/pulls"].join("\n"));
    expect(calls).toContain(`head=${branch}`);
    expect(calls).toContain("base=main");
    expect(calls).toContain("title=Fix the greeting typo");
    expect(calls).not.toContain("Fix the greeting\n");
    expect(calls).not.toContain(`cwd=${repo.path}`);
    // The worktree stays until the pull request is merged or the item is discarded.
    expect(existsSync(wtPath(item))).toBe(true);
    expect(finisher().start(done.id, "merge")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect((await run(done, "discard")).finish?.worktreeRemoved).toBe(true);
  });

  it("takes the open pull request's URL when one exists for the branch already", SLOW, async () => {
    ghMode("exists");
    const done = await run(await doneItem(), "pull_request");
    expect(done.finish?.pullRequest?.url).toBe("https://github.com/acme/orders-api/pull/3");
  });

  it("pushes nothing when gh is logged out to the host, or missing", SLOW, async () => {
    ghMode("logged-out");
    const out = await run(await doneItem(), "pull_request");
    expect(out.finish?.failed?.detail).toMatch(/^Nothing was pushed\. gh is not logged in to github\.com\. Run `gh auth login`/);
    expect(ghCalls()).toContain("auth\nstatus\n--hostname\ngithub.com");
    expect(ghCalls()).not.toContain("--method\nPOST");
    const missing = await run(await doneItem(), "pull_request", { ghCommand: [join(root, "no-such-gh")] });
    expect(missing.finish?.failed?.detail).toMatch(/^Nothing was pushed\. The GitHub CLI \(gh\) is not installed/);
    expect(await plain(bare, "for-each-ref", "refs/heads/")).toBe("");
  });

  it("records gh's own refusal after the push", SLOW, async () => {
    const item = await doneItem();
    writeFileSync(join(ghDir, "gh"), STUB_GH.replace(`echo "${PR_URL}"; exit 0 ;;`, `echo "gh: Resource not accessible (HTTP 403)" >&2; exit 1 ;;`));
    const done = await run(item, "pull_request");
    expect(done.finish?.failed?.detail).toBe("gh could not open the pull request on github.com/acme/orders-api: gh: Resource not accessible (HTTP 403)");
  });

  it("refuses to push when origin points somewhere else than when the item started", SLOW, async () => {
    const item = await doneItem();
    await plain(repo.path, "remote", "set-url", "origin", "https://evil.example.com/x/y.git");
    const done = await run(item, "pull_request");
    expect(done.finish?.failed?.detail).toMatch(/^origin now points at https:\/\/evil\.example\.com\/x\/y\.git, not https:\/\/github\.com\/acme\/orders-api\.git/);
    expect(ghCalls()).not.toContain("--method\nPOST");
    expect(await plain(bare, "for-each-ref", "refs/heads/")).toBe("");
  });

  it("refuses without a recorded origin, and in local-only mode", SLOW, async () => {
    await plain(repo.path, "remote", "remove", "origin");
    const noOrigin = await doneItem();
    expect(noOrigin.worktrees[0]?.pushUrl).toBeUndefined();
    expect(finisher().start(noOrigin.id, "pull_request")).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringMatching(/no origin remote/) } });
    await plain(repo.path, "remote", "add", "origin", ORIGIN);
    expect(finisher({ localOnly: true }).start((await doneItem()).id, "pull_request")).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("gives the SSH agent socket only to a push that really goes over SSH, after git's URL rewrites", SLOW, async () => {
    const pushes: unknown[] = [];
    const spy: Git = { ...git, push: (...args) => (pushes.push(args[4]), Promise.resolve({ ok: true, value: undefined })) };
    await run(await doneItem(), "pull_request", { git: spy, sshAuthSock: "/tmp/agent.sock" });
    // A user who forces SSH for GitHub: origin is written as HTTPS, git pushes over SSH.
    await plain(repo.path, "config", "--unset", `url.${bare}.insteadOf`);
    await plain(repo.path, "config", "url.git@github.com:.insteadOf", "https://github.com/");
    const forced = await doneItem();
    expect(forced.worktrees[0]?.pushUrl).toBe(ORIGIN);
    await run(forced, "pull_request", { git: spy, sshAuthSock: "/tmp/agent.sock" });
    await plain(repo.path, "config", "--unset", "url.git@github.com:.insteadOf");
    await plain(repo.path, "remote", "set-url", "origin", "git@github.com:acme/orders-api.git");
    const ssh = await doneItem();
    expect(ssh.worktrees[0]?.pushUrl).toBe("git@github.com:acme/orders-api.git");
    await run(ssh, "pull_request", { git: spy, sshAuthSock: "/tmp/agent.sock" });
    expect(pushes).toEqual([{}, { sshAuthSock: "/tmp/agent.sock" }, { sshAuthSock: "/tmp/agent.sock" }]);
  });
});

describe("Discard", () => {
  it("removes the worktree and the branch", SLOW, async () => {
    const item = await doneItem();
    const done = await run(item, "discard");
    expect(done.finish).toMatchObject({ worktreeRemoved: true });
    expect(existsSync(wtPath(item))).toBe(false);
    expect(await branchExists(item.worktrees[0]!.branch)).toBe(false);
    expect(await plain(repo.path, "rev-parse", "main")).toBe(item.worktrees[0]!.baseCommit);
    expect(lastEvents(done, 1)).toMatchObject([{ type: "discarded", repoId: "orders-api" }]);
  });

  it("handles a worktree the engineer removed already", SLOW, async () => {
    const item = await doneItem();
    rmSync(wtPath(item), { recursive: true, force: true });
    const done = await run(item, "discard");
    expect(done.finish?.worktreeRemoved).toBe(true);
    expect(await branchExists(item.worktrees[0]!.branch)).toBe(false);
    expect(await plain(repo.path, "worktree", "list", "--porcelain")).not.toContain(".tokama/wt");
  });
});

describe("a restart in the middle of an action", () => {
  it("records the running action as interrupted; trying again finishes it", SLOW, async () => {
    const item = await doneItem();
    // The engine stopped after the merge moved main and removed the branch, before it recorded the result.
    store.append(item.id, [{ type: "finish_started", action: "merge" }]);
    await plain(repo.path, "merge", "-q", "--ff-only", commitOf(item));
    await plain(repo.path, "worktree", "remove", "--force", wtPath(item));
    await plain(repo.path, "branch", "-D", item.worktrees[0]!.branch);

    store = ItemStore.open({ home, hostId: HOST }).store;
    const finish = finisher();
    finish.recover();
    const recovered = store.get(item.id)!;
    expect(recovered.finish?.running).toBeUndefined();
    expect(recovered.finish?.failed).toMatchObject({ action: "merge", detail: expect.stringMatching(/engine stopped while Merge ran/) });
    finish.recover();
    expect(lastEvents(recovered, 1)).toMatchObject([{ type: "finish_failed" }]);

    const done = await run(recovered, "merge");
    expect(done.finish).toMatchObject({ merged: { commit: commitOf(item) }, worktreeRemoved: true });
    expect(done.finish?.failed).toBeUndefined();
  });

  it("leaves an action that another host owns alone", SLOW, async () => {
    const item = await doneItem();
    store.append(item.id, [{ type: "finish_started", action: "discard" }]);
    const other = ItemStore.open({ home, hostId: "host_0190a000-0000-7000-8000-000000000002" as HostId }).store;
    createFinisher({ store: other, git, runner: createProcessRunner(), repo: () => repo }).recover();
    expect(other.get(item.id as ItemId)?.finish?.running).toBe("discard");
  });
});
