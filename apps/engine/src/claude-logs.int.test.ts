// The `all` usage scope: Claude Code's session logs read in the background into the index, then
// incrementally, matched to repos, and never a word of message content in the index, the reply
// or the engine's log.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { manualClock, parseQueryResult, type RepoId } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeLogs } from "./claude-logs.js";
import { startEngine } from "./engine.js";
import { ItemIndex } from "./item-index.js";
import { tempEngineDir, waitFor } from "./testing/helpers.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "core", "src", "adapters", "agent", "claude-code", "testing", "fixtures", "session-logs");
const SENTINEL = "SENTINEL";
const MINUTE = 60_000;
const folderOf = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A recorded log with its times moved to `at`, so they fall inside the report's range. */
function log(name: string, at: number): string {
  return readFileSync(join(FIXTURES, name), "utf8").replace(/"timestamp":"[^"]+"/g, `"timestamp":"${new Date(at).toISOString()}"`);
}

/** Claude Code's projects folder with one repo's sessions and one session elsewhere. */
function logsFor(repoPath: string, at: number): { root: string; project: string } {
  const root = tempDir("tokama-claude-projects-");
  const project = join(root, folderOf(repoPath));
  mkdirSync(join(project, "00000000-0000-4000-8000-00000000000a", "subagents"), { recursive: true });
  writeFileSync(join(project, "00000000-0000-4000-8000-00000000000a.jsonl"), log("session-a.jsonl", at));
  writeFileSync(join(project, "00000000-0000-4000-8000-00000000000a", "subagents", "agent-a0000000000000001.jsonl"), log("subagent.jsonl", at));
  mkdirSync(join(root, "-Users-someone-scratch"));
  writeFileSync(join(root, "-Users-someone-scratch", "00000000-0000-4000-8000-00000000000b.jsonl"), log("session-b.jsonl", at));
  return { root, project };
}

describe("ClaudeLogs", () => {
  function setUp(now: number, repoPath: string) {
    const { root, project } = logsFor(repoPath, now - 10 * MINUTE);
    const index = ItemIndex.open(join(tempDir("tokama-claude-index-"), "tokama.db"));
    cleanups.push(() => index.close());
    const clock = manualClock(now);
    let changes = 0;
    const logs = new ClaudeLogs({
      index,
      root,
      repos: async () => [{ id: "orders-api" as RepoId, path: repoPath, worktreeFolder: ".tokama-wt" }],
      clock,
      onChange: () => changes++,
    });
    return { logs, clock, root, project, changes: () => changes };
  }

  it("scans in the background with progress, then has the usage per day, model and repo", async () => {
    const now = Date.now();
    const { logs, changes } = setUp(now, "/Users/someone/orders-api");
    expect(logs.status()).toMatchObject({ state: "scanning", filesDone: 0 });
    logs.refresh();
    expect(logs.status().state).toBe("scanning");
    await logs.settled();
    expect(logs.status()).toEqual({ state: "ready", filesDone: 3, filesTotal: 3, asOf: now });
    expect(changes()).toBe(1);
    const entries = logs.entries(0);
    expect(entries.map((e) => [e.model, e.repoId, e.calls, e.tokens.output]).sort()).toEqual([
      // The scratch session's copy of req_2 counts once, in the repo's session where it was first read.
      ["claude-haiku-5-5", null, 1, 100],
      ["claude-haiku-5-5", "orders-api", 1, 20],
      ["claude-opus-5-5", "orders-api", 1, 420],
      ["claude-sonnet-5-5", "orders-api", 1, 80],
    ]);
    expect(entries.every((e) => e.cliId === "claude-code" && e.costUsd !== null)).toBe(true);
  });

  it("reads only new lines on the next scan, and not before the scan interval has passed", async () => {
    const now = Date.now();
    const { logs, clock, project } = setUp(now, "/Users/someone/orders-api");
    logs.refresh();
    await logs.settled();
    const line = log("subagent.jsonl", now - MINUTE).trim().replace("req_00000000000000000000000005", "req_new");
    appendFileSync(join(project, "00000000-0000-4000-8000-00000000000a.jsonl"), `${line}\n`);

    clock.advance(30_000);
    logs.refresh();
    await logs.settled();
    expect(logs.entries(0).reduce((n, e) => n + e.calls, 0)).toBe(4);

    clock.advance(31_000);
    logs.refresh();
    await logs.settled();
    expect(logs.entries(0).reduce((n, e) => n + e.calls, 0)).toBe(5);
    expect(logs.status().asOf).toBe(now + 61_000);
  });

  it("says when there are no logs", async () => {
    const now = Date.now();
    const { logs, root } = setUp(now, "/Users/someone/orders-api");
    rmSync(root, { recursive: true });
    logs.refresh();
    await logs.settled();
    expect(logs.status()).toMatchObject({ state: "unavailable", note: expect.stringMatching(/no session logs/) });
  });
});

describe("usage query, all scope", () => {
  it("counts the logs, maps them to repos, and keeps every word of content out of the index, the reply and the log", { timeout: 20_000 }, async () => {
    const base = tempDir("tk-logs-");
    const home = join(base, "home");
    const repoPath = join(base, "orders-api");
    mkdirSync(home);
    mkdirSync(repoPath);
    writeFileSync(join(home, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${repoPath}\n    base_branch: main\n`);
    const { root } = logsFor(repoPath, Date.now() - 10 * MINUTE);
    const lines: string[] = [];

    const dir = tempEngineDir(cleanups);
    const started = await startEngine({
      dir,
      home,
      claudeLogs: root,
      planSources: {},
      log: (line) => lines.push(line),
      processTable: { list: async () => [], bootTime: () => 0, signalGroup: () => undefined },
    });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const connected = await connect({ dir, startTimeoutMs: 2_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    const engineClient: EngineClient = connected.value;
    cleanups.push(() => engineClient.close());
    const events: ClientEvent[] = [];
    void (async () => {
      for await (const event of engineClient.events()) events.push(event);
    })();

    // The default scope does not read the logs.
    const tokama = await engineClient.query({ type: "usage", range: 14 });
    expect(tokama.ok && tokama.data).toMatchObject({ scope: "tokama", totals: { calls: 0 } });
    expect(tokama.ok && tokama.data.scan).toBeUndefined();

    const first = await engineClient.query({ type: "usage", range: 14, scope: "all" });
    expect(first.ok && first.data.scan?.state).toBe("scanning");
    await waitFor(() => events.some((event) => event.kind === "event" && event.event.type === "usage_changed"), 5_000, "usage_changed");
    const reply = await engineClient.query({ type: "usage", range: 14, scope: "all" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("usage", reply.data).ok).toBe(true);
    const report = reply.data;
    expect(report.scope).toBe("all");
    expect(report.scan).toMatchObject({ state: "ready", filesDone: 3, filesTotal: 3 });
    expect(report.totals).toMatchObject({ calls: 4, unpricedCalls: 0, tokens: { input: 965, output: 620, cacheRead: 63000, cacheWrite: 2000 } });
    // The scratch folder sorts first, so the copy of req_2 there is the one counted.
    expect(report.repos).toEqual([expect.objectContaining({ repoId: "orders-api", tokens: 33502 }), expect.objectContaining({ repoId: null, tokens: 33083 })]);
    expect(report.models?.map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(report.tokenSummary).toMatchObject({ processed: 66585, cachedInput: 63000, uncachedInput: 2965, output: 620 });
    expect(report.tokenSummary?.cacheSavingsFactor).toBeGreaterThan(1);

    // Privacy: the index holds numbers, ids and hashes only.
    await started.value.close();
    const stored = readdirSync(home)
      .filter((name) => name.startsWith("tokama.db"))
      .map((name) => readFileSync(join(home, name)).toString("latin1"))
      .join("\n");
    expect(stored).toContain("req_00000000000000000000000001");
    const out = [stored, JSON.stringify(first), JSON.stringify(reply), lines.join("\n")];
    for (const text of out) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("/Users/someone");
      expect(text).not.toContain("-Users-someone-scratch");
      expect(text).not.toContain(folderOf(repoPath));
      expect(text).not.toContain(root);
      expect(text).not.toContain("toolu_");
    }
    expect(existsSync(join(home, "tokama.db"))).toBe(true);
  });

  it("serves sample log usage in sample mode without reading any logs", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, sample: true, claudeLogs: "/nonexistent/claude/projects" });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const connected = await connect({ dir, startTimeoutMs: 2_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    const reply = await connected.value.query({ type: "usage", range: 30, scope: "all" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("usage", reply.data).ok).toBe(true);
    expect(reply.data.scan).toMatchObject({ state: "ready" });
    expect(reply.data.models?.length).toBeGreaterThanOrEqual(3);
    expect(reply.data.repos?.some((repo) => repo.repoId === null)).toBe(true);
    expect(reply.data.days.every((day) => (day.tokens ?? 0) > 0)).toBe(true);
  });
});
