// The repo commands over the engine API: suggest_repo, add_repo and remove_repo edit repos.yaml in
// Tokama's home, the setup query follows, and a setup_changed event tells every client.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
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

function gitRepo(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
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
      data: { path, gitRepo: true, branch: "main", id: "billing-api", checks: ["pnpm test"], problem: null },
    });
    expect(await client.command({ type: "add_repo", path, checks: ["pnpm test"] })).toEqual({ ok: true, data: { repo: { id: "billing-api", baseBranch: "main" } } });
    await waitFor(() => events.some((event) => event.kind === "event" && event.event.type === "setup_changed"), 5_000, "setup_changed");
    // The sample repos first, then the repos of repos.yaml.
    expect(await repoIds(client)).toEqual(["orders-api", "checkout-web", "inventory-service", "billing-api"]);
    expect(readFileSync(join(home, "repos.yaml"), "utf8")).toContain(`path: ${path}`);

    expect(await client.command({ type: "add_repo", path })).toMatchObject({ ok: false, error: { code: "already_exists" } });
    expect(await client.command({ type: "remove_repo", repoId: "billing-api" })).toEqual({ ok: true, data: null });
    expect(await repoIds(client)).toEqual(["orders-api", "checkout-web", "inventory-service"]);
    expect(readFileSync(join(home, "repos.yaml"), "utf8")).not.toContain("billing-api");
    expect(await client.command({ type: "remove_repo", repoId: "billing-api" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("answers in plain words for a folder that isn't a repo, and runs two adds one after the other", async () => {
    const { root, client } = await setUp({ sample: false });
    mkdirSync(join(root, "notes"));
    expect(await client.command({ type: "add_repo", path: join(root, "notes") })).toEqual({ ok: false, error: { code: "invalid_request", message: "This folder isn't a git repo." } });
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
