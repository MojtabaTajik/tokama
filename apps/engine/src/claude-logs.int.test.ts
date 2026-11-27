// Claude Code's session logs, read in the background into the index to split a plan limit, then
// incrementally, and never a word of message content in the index, the reply or the engine's log.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { manualClock, parseQueryResult } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeLogs, logReader } from "./claude-logs.js";
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

/** A recorded log with its times moved to `at`, so they fall inside the look-back. */
function log(name: string, at: number): string {
  return readFileSync(join(FIXTURES, name), "utf8").replace(/"timestamp":"[^"]+"/g, `"timestamp":"${new Date(at).toISOString()}"`);
}

/** Claude Code's projects folder with one project's sessions and one session elsewhere. */
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
  const reader = logReader()!;
  function setUp(now: number) {
    const { root, project } = logsFor("/Users/someone/orders-api", now - 10 * MINUTE);
    const index = ItemIndex.open(join(tempDir("tokama-claude-index-"), "tokama.db"));
    cleanups.push(() => index.close());
    const clock = manualClock(now);
    let changes = 0;
    const logs = new ClaudeLogs({ index, reader, root, clock, onChange: () => changes++ });
    return { logs, index, clock, root, project, changes: () => changes };
  }
  const outputs = (logs: ClaudeLogs, to: number) => logs.totals(0, to).map(({ model, tokens }) => [model, tokens.output]);

  it("scans in the background, then has the tokens per model", async () => {
    const now = Date.now();
    const { logs, changes } = setUp(now);
    expect(logs.complete()).toBe(false);
    logs.refresh();
    expect(logs.complete()).toBe(false);
    await logs.settled();
    expect(logs.complete()).toBe(true);
    expect(changes()).toBe(1);
    // The scratch session's copy of req_2 counts once.
    expect(outputs(logs, now)).toEqual([
      ["claude-haiku-5-5", 120],
      ["claude-opus-5-5", 420],
      ["claude-sonnet-5-5", 80],
    ]);
  });

  it("reads only new lines on the next scan, and not before the scan interval has passed", async () => {
    const now = Date.now();
    const { logs, clock, project } = setUp(now);
    logs.refresh();
    await logs.settled();
    const line = log("subagent.jsonl", now - MINUTE).trim().replace("req_00000000000000000000000005", "req_new");
    appendFileSync(join(project, "00000000-0000-4000-8000-00000000000a.jsonl"), `${line}\n`);
    const sum = () => logs.totals(0, now + 120_000).reduce((n, row) => n + row.tokens.output, 0);
    const before = sum();

    clock.advance(30_000);
    logs.refresh();
    await logs.settled();
    expect(sum()).toBe(before);

    clock.advance(31_000);
    logs.refresh();
    await logs.settled();
    expect(sum()).toBeGreaterThan(before);
  });

  it("keeps the tokens across a restart, before the next scan ends", async () => {
    const now = Date.now();
    const { logs, index, root } = setUp(now);
    logs.refresh();
    await logs.settled();
    const restarted = new ClaudeLogs({ index, reader, root, clock: manualClock(now), onChange: () => {} });
    expect(restarted.complete()).toBe(false);
    expect(outputs(restarted, now)).toHaveLength(3);
    expect(restarted.coveredFrom()).toBe(now - 10 * MINUTE);
  });

  it("is complete from the last scan that read every log: a later scan that runs does not undo it, one that fails and one that finds no logs do", async () => {
    const now = Date.now();
    const { logs, clock, root, index } = setUp(now);
    expect(logs.complete()).toBe(false);
    logs.refresh();
    expect(logs.complete()).toBe(false);
    await logs.settled();
    expect(logs.complete()).toBe(true);

    // A new scan is running, and the earlier scan still stands.
    clock.advance(61_000);
    logs.refresh();
    expect(logs.complete()).toBe(true);
    await logs.settled();
    expect(logs.complete()).toBe(true);

    const failing = new ClaudeLogs({ index, reader: { ...reader, scan: async () => { throw new Error("cannot read") } }, root, clock: manualClock(now), onChange: () => {} });
    failing.refresh();
    await failing.settled();
    expect(failing.complete()).toBe(false);

    rmSync(root, { recursive: true });
    clock.advance(61_000);
    logs.refresh();
    await logs.settled();
    expect(logs.complete()).toBe(false);
  });

  it("is not complete when there are no logs", async () => {
    const now = Date.now();
    const { logs, root } = setUp(now);
    rmSync(root, { recursive: true });
    logs.refresh();
    await logs.settled();
    expect(logs.complete()).toBe(false);
    expect(logs.coveredFrom()).toBeUndefined();
  });
});

describe("usage query and the logs", () => {
  it("reads the logs, and keeps every word of content out of the index, the reply and the log", { timeout: 20_000 }, async () => {
    const base = tempDir("tk-logs-");
    const home = join(base, "home");
    const repoPath = join(base, "orders-api");
    mkdirSync(home);
    mkdirSync(repoPath);
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
    const connected = await connect({ dir, lockPath: started.value.endpoint.lockPath, startTimeoutMs: 2_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    const engineClient: EngineClient = connected.value;
    cleanups.push(() => engineClient.close());
    const events: ClientEvent[] = [];
    void (async () => {
      for await (const event of engineClient.events()) events.push(event);
    })();

    // A query starts the scan and does not wait for it; the end of the scan is an event.
    const first = await engineClient.query({ type: "usage" });
    expect(first.ok).toBe(true);
    await waitFor(() => events.some((event) => event.kind === "event" && event.event.type === "usage_changed"), 5_000, "usage_changed");
    const reply = await engineClient.query({ type: "usage" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("usage", reply.data).ok).toBe(true);

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
});
