// The repo commands over the engine API: suggest_repo, add_repo and remove_repo edit repos.yaml in
// Tokama's home, the setup query follows, and a setup_changed event tells every client.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir, waitFor } from "./testing/helpers.js";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function setUp(options: { sample?: boolean; home?: boolean } = {}) {
  const dir = tempEngineDir(cleanups);
  const root = realpathSync(dirname(dir));
  const home = join(root, "tokama");
  const started = await startEngine({ dir, sample: options.sample ?? true, ...(options.home === false ? {} : { home }) });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  const connected = await connect({ dir, lockPath: started.value.endpoint.lockPath, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return { root, home, client: connected.value };
}

function collect(client: EngineClient): ClientEvent[] {
  const events: ClientEvent[] = [];
  void (async () => {
    for await (const event of client.events()) events.push(event);
  })();
  return events;
}

function gitRepo(root: string, name: string, options: { commit?: boolean } = {}): string {
  const path = join(root, name);
  mkdirSync(path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  if (options.commit !== false) execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: path });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  writeFileSync(join(path, "pnpm-lock.yaml"), "");
  return path;
}

const repoIds = async (client: EngineClient) => {
  const setup = await client.query({ type: "setup" });
  if (!setup.ok) throw new Error(setup.error.message);
  return setup.data.repos.map((repo) => repo.id);
};

describe("repo commands", () => {
  it("suggests, adds and removes a repo; setup follows and clients hear setup_changed", async () => {
    const { root, home, client } = await setUp();
    const events = collect(client);
    const path = gitRepo(root, "billing-api");

    expect(await client.query({ type: "suggest_repo", path })).toEqual({
      ok: true,
      data: { path, displayPath: path, gitRepo: true, hasCommits: true, branch: "main", id: "billing-api", checks: ["pnpm test"], checksFrom: ["test"], defaultBranch: "main", branches: [{ name: "main", group: "default" }], moreBranches: 0, fallbackCheck: null, fallbackFromPackage: false, firstCommit: null, problem: null },
    });
    expect(await client.command({ type: "add_repo", path, checks: ["pnpm test"] })).toEqual({ ok: true, data: { repo: { id: "billing-api", baseBranch: "main", checks: ["pnpm test"] } } });
    await waitFor(() => events.some((event) => event.kind === "event" && event.event.type === "setup_changed"), 5_000, "setup_changed");
    expect(await client.query({ type: "repo_branches", repoId: "billing-api" })).toEqual({ ok: true, data: { defaultBranch: "main", branches: [{ name: "main", group: "default" }], moreBranches: 0 } });
    expect(await client.query({ type: "repo_branches", repoId: "inventory-service" })).toEqual({ ok: true, data: { defaultBranch: "develop", branches: [{ name: "develop", group: "default" }], moreBranches: 0 } });
    expect(await client.query({ type: "repo_branches", repoId: "nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    // The sample repos first, then the repos of repos.yaml.
    expect(await repoIds(client)).toEqual(["orders-api", "checkout-web", "inventory-service", "billing-api"]);
    expect(readFileSync(join(home, "repos.yaml"), "utf8")).toContain(`path: ${path}`);

    expect(await client.command({ type: "add_repo", path })).toMatchObject({ ok: false, error: { code: "already_exists" } });
    expect(await client.command({ type: "remove_repo", repoId: "billing-api" })).toEqual({ ok: true, data: null });
    expect(await repoIds(client)).toEqual(["orders-api", "checkout-web", "inventory-service"]);
    expect(readFileSync(join(home, "repos.yaml"), "utf8")).not.toContain("billing-api");
    expect(await client.command({ type: "remove_repo", repoId: "billing-api" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("reports a repo without commits and refuses to add it until it has one", async () => {
    const { root, home, client } = await setUp({ sample: false });
    const path = gitRepo(root, "fresh", { commit: false });
    const message = "This repo has no commits yet. Make a first commit, then add it.";
    expect(await client.query({ type: "suggest_repo", path })).toMatchObject({ ok: true, data: { gitRepo: true, hasCommits: false, problem: message } });
    expect(await client.command({ type: "add_repo", path })).toEqual({ ok: false, error: { code: "invalid_request", message } });
    expect(existsSync(join(home, "repos.yaml"))).toBe(false);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first", "--allow-empty"], { cwd: path });
    expect(await client.query({ type: "suggest_repo", path })).toMatchObject({ ok: true, data: { hasCommits: true, problem: null } });
    expect(await client.command({ type: "add_repo", path })).toMatchObject({ ok: true });
  });

  it("sets up git in a plain folder over the API, then adds it", async () => {
    const { root, home, client } = await setUp({ sample: false });
    // The commit needs an identity; git reads it from HOME.
    const oldHome = process.env["HOME"];
    writeFileSync(join(root, ".gitconfig"), "[user]\n\tname = t\n\temail = t@example.com\n");
    process.env["HOME"] = root;
    cleanups.push(() => void (oldHome === undefined ? delete process.env["HOME"] : (process.env["HOME"] = oldHome)));
    const path = join(root, "plain-app");
    mkdirSync(path);
    writeFileSync(join(path, "index.js"), "console.log(1);\n");
    const suggested = await client.query({ type: "suggest_repo", path });
    expect(suggested).toMatchObject({ ok: true, data: { gitRepo: false, problem: "This folder isn't a git repo yet.", firstCommit: { files: 2, sample: [{ path: ".gitignore", bytes: 43 }, { path: "index.js", bytes: 16 }], addsGitignore: true, refusal: null }, fallbackCheck: "node --check index.js" } });
    expect(await client.command({ type: "add_repo", path })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await client.command({ type: "init_repo", path })).toEqual({ ok: true, data: { gitInit: true, ignoreRules: 5 } });
    expect(await client.command({ type: "first_commit", path })).toMatchObject({ ok: true, data: { commit: expect.stringMatching(/^[0-9a-f]{7}$/), files: 2 } });
    expect(existsSync(join(home, "repos.yaml"))).toBe(false);
    expect(await client.command({ type: "add_repo", path })).toMatchObject({ ok: true, data: { repo: { id: "plain-app", baseBranch: "main" } } });
    expect(await client.command({ type: "init_repo", path: join(root, "missing") })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("suggests node --check for a plain JS repo without package.json", async () => {
    const { root, client } = await setUp({ sample: false });
    const path = gitRepo(root, "plain-js");
    rmSync(join(path, "package.json"));
    writeFileSync(join(path, "index.js"), "console.log(1);\n");
    expect(await client.query({ type: "suggest_repo", path })).toMatchObject({ ok: true, data: { checks: [], fallbackCheck: "node --check index.js" } });
  });

  it("updates a repo's base branch and checks, keeps comments, and tells clients", async () => {
    const { root, home, client } = await setUp();
    const events = collect(client);
    const path = gitRepo(root, "billing-api");
    expect((await client.command({ type: "add_repo", path, checks: ["pnpm test"] })).ok).toBe(true);
    const file = join(home, "repos.yaml");
    writeFileSync(file, `# mine\n${readFileSync(file, "utf8")}`);
    const before = events.length;

    expect(await client.command({ type: "update_repo", repoId: "billing-api", baseBranch: "develop", checks: ["pnpm test", "pnpm lint"] })).toEqual({
      ok: true,
      data: { repo: { id: "billing-api", baseBranch: "develop", checks: ["pnpm test", "pnpm lint"] } },
    });
    await waitFor(() => events.slice(before).some((event) => event.kind === "event" && event.event.type === "setup_changed"), 5_000, "setup_changed");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# mine\n");
    expect(text).toContain("base_branch: develop");
    expect(text).toContain("- pnpm lint");
    const setup = await client.query({ type: "setup" });
    expect(setup.ok && setup.data.repos.find((repo) => repo.id === "billing-api")).toEqual({ id: "billing-api", baseBranch: "develop", checks: ["pnpm test", "pnpm lint"], path: expect.stringMatching(/billing-api$/) });

    expect(await client.command({ type: "update_repo", repoId: "billing-api", baseBranch: "bad branch", checks: [] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await client.command({ type: "update_repo", repoId: "billing-api", baseBranch: "main", checks: ["a | b"] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await client.command({ type: "update_repo", repoId: "nope", baseBranch: "main", checks: [] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    // A sample repo is not in repos.yaml: editing it is refused and the file is left alone.
    expect(await client.command({ type: "update_repo", repoId: "orders-api", baseBranch: "main", checks: [] })).toMatchObject({ ok: false, error: { code: "not_found", message: expect.stringContaining("sample repo") } });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("keeps the sample repo ids in sample mode and marks the sample repos", async () => {
    const { root, home, client } = await setUp();
    const setup = await client.query({ type: "setup" });
    expect(setup.ok && setup.data.repos.every((repo) => repo.sample === true)).toBe(true);
    const path = gitRepo(root, "orders-api");
    expect(await client.query({ type: "suggest_repo", path })).toMatchObject({ ok: true, data: { id: "orders-api-2" } });
    expect(await client.command({ type: "add_repo", path, id: "orders-api" })).toMatchObject({ ok: false, error: { code: "already_exists" } });
    expect(await client.command({ type: "add_repo", path })).toEqual({ ok: true, data: { repo: { id: "orders-api-2", baseBranch: "main", checks: expect.any(Array) } } });
    const after = await client.query({ type: "setup" });
    expect(after.ok && after.data.repos.find((repo) => repo.id === "orders-api-2")).toEqual({ id: "orders-api-2", baseBranch: "main", checks: expect.any(Array), path: expect.stringMatching(/orders-api$/) });
    // A sample repo is not in repos.yaml: removing it is refused and the file is left alone.
    const before = readFileSync(join(home, "repos.yaml"), "utf8");
    expect(await client.command({ type: "remove_repo", repoId: "orders-api" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(readFileSync(join(home, "repos.yaml"), "utf8")).toBe(before);
  });

  it("answers in plain words for a folder that isn't a repo, and runs two adds one after the other", async () => {
    const { root, client } = await setUp({ sample: false });
    mkdirSync(join(root, "notes"));
    expect(await client.command({ type: "add_repo", path: join(root, "notes") })).toEqual({ ok: false, error: { code: "invalid_request", message: "This folder isn't a git repo yet." } });
    const [a, b] = [gitRepo(root, "a"), gitRepo(root, "b")];
    const results = await Promise.all([client.command({ type: "add_repo", path: a }), client.command({ type: "add_repo", path: b })]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(await repoIds(client)).toEqual(["a", "b"]);
  });

  it("refuses repo changes without a Tokama home", async () => {
    const { root, client } = await setUp({ home: false });
    expect(await client.command({ type: "add_repo", path: gitRepo(root, "a") })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(await client.query({ type: "suggest_repo", path: root })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  });
});
