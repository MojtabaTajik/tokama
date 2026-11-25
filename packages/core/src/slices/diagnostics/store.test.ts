import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "../../kernel/clock/index.js";
import { DiagnosticEntrySchema, type DiagnosticId, type MachineFacts } from "../../kernel/schemas/index.js";
import { DiagnosticsStore, ENTRIES_FILE, RUNNING_FILE, SETTINGS_FILE, type DiagnosticsStoreOptions } from "./index.js";
import { FORBIDDEN, SENTINEL, SENTINEL_CONTEXT, sentinelStack } from "./testing.js";

const MACHINE: MachineFacts = { os: "linux", osVersion: "24.04", distro: "ubuntu", arch: "x64", cpu: { family: "AMD Ryzen 7", cores: 16 }, ramGb: "16-32", gpu: null };
const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 25, 10, 0, 0);

let root: string;
let dir: string;
let clock: ManualClock;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-diagnostics-")));
  dir = join(root, "diagnostics");
  clock = manualClock(START);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const open = (options: Partial<DiagnosticsStoreOptions> = {}) =>
  DiagnosticsStore.open({ dir, engineVersion: "0.1.0", machine: MACHINE, redaction: () => SENTINEL_CONTEXT, clock, ...options });

/** Every byte under the diagnostics folder, as text. */
function allFiles(): string {
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
}

function lines(): unknown[] {
  return readFileSync(join(dir, ENTRIES_FILE), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function expectNoSentinel(text: string): void {
  for (const fragment of FORBIDDEN) expect(text, `"${fragment}" reached:\n${text}`).not.toContain(fragment);
}

describe("DiagnosticsStore", () => {
  it("writes cleaned errors: no sentinel reaches the file or the list", async () => {
    const store = await open();
    const error = new Error(`cannot read ${SENTINEL.repoPath}/src/billing.ts for ${SENTINEL.email} with ${SENTINEL.github}`);
    error.stack = sentinelStack();
    store.error("engine", "request", error);
    store.error("engine", "uncaught", `thrown text ${SENTINEL.anthropic} ${SENTINEL.home}/x`);
    store.report({ type: "error", source: "renderer", where: "uncaught", stack: sentinelStack() }, "0.2.0");
    store.close();

    expectNoSentinel(allFiles());
    const listed = store.list();
    expectNoSentinel(JSON.stringify(listed));
    expect(listed.entries).toHaveLength(3);
    const [renderer] = listed.entries;
    expect(renderer).toMatchObject({ type: "error", source: "renderer", where: "uncaught", name: "Error", appVersion: "0.2.0", engineVersion: "0.1.0", machine: MACHINE });
    for (const line of lines()) expect(DiagnosticEntrySchema.safeParse(line).success).toBe(true);
    expect(lstatSync(join(dir, ENTRIES_FILE)).mode & 0o777).toBe(0o600);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("cleans again on list, with repos added after the entry was written", async () => {
    let context = { ...SENTINEL_CONTEXT, repoNames: [] as string[] };
    const store = await open({ redaction: () => context });
    store.report({ type: "error", source: "desktop", where: "uncaught", stack: "Error: build of invoicing-core failed" });
    context = { ...context, repoNames: ["invoicing-core"] };
    expect(JSON.stringify(store.list())).not.toContain("invoicing-core");
  });

  it("gives entries the envelope: ids, UTC time, install and session ids, versions, CLIs", async () => {
    const store = await open();
    store.setClis([{ cliId: "claude-code", version: "2.1.331" }, { cliId: "codex-cli", version: "not a version!" }, { cliId: "unknown-cli" }]);
    store.warning("engine", "index_rebuilt");
    const [entry] = store.list().entries;
    expect(entry).toMatchObject({
      schemaVersion: 1,
      at: START,
      installId: store.settings().installId,
      sessionId: store.sessionId,
      appVersion: null,
      clis: [{ cliId: "claude-code", version: "2.1.331" }, { cliId: "codex-cli", version: null }],
      type: "warning",
      code: "index_rebuilt",
    });
    expect(entry?.id).toMatch(/^diag_/);
  });

  it("counts usage per UTC day, written on flush and on a new day", async () => {
    const store = await open();
    store.count("start_task");
    store.count("start_task");
    store.count("approve");
    expect(store.list({ types: ["usage"] }).entries).toEqual([]);
    clock.advance(DAY);
    store.count("finish_merge");
    store.close();
    const usage = store.list({ types: ["usage"] }).entries;
    expect(usage.map((entry) => entry.type === "usage" && { day: entry.day, counts: entry.counts })).toEqual([
      { day: "2026-11-26", counts: [{ action: "finish_merge", count: 1 }] },
      { day: "2026-11-25", counts: [{ action: "start_task", count: 2 }, { action: "approve", count: 1 }] },
    ]);
  });

  it("filters by type and time, newest first, and caps the reply", async () => {
    const store = await open();
    for (let i = 0; i < 5; i++) {
      store.warning("engine", "item_not_loaded");
      clock.advance(1000);
    }
    store.crash("desktop", "unclean_exit");
    expect(store.list({ types: ["crash"] }).entries).toHaveLength(1);
    const ranged = store.list({ types: ["warning"], since: START + 1000, until: START + 3000 });
    expect(ranged.entries.map((entry) => entry.at)).toEqual([START + 3000, START + 2000, START + 1000]);
    expect(store.list({ limit: 2 })).toMatchObject({ truncated: true, entries: [{ type: "crash" }, { type: "warning" }] });
  });

  it("deletes by ids and all, on disk too", async () => {
    const store = await open();
    store.warning("engine", "item_not_loaded");
    store.warning("engine", "index_rebuilt");
    store.warning("renderer", "renderer_unresponsive");
    const [first] = store.list().entries;
    expect(store.delete({ ids: [first!.id, "diag_00000000-0000-7000-8000-000000000000" as DiagnosticId] })).toBe(1);
    expect(lines()).toHaveLength(2);
    // The first store is still open, so the second also records a crash; only warnings count here.
    expect((await open()).list({ types: ["warning"] }).entries).toHaveLength(2);
    expect(store.delete({ all: true })).toBe(2);
    expect(readFileSync(join(dir, ENTRIES_FILE), "utf8")).toBe("");
  });

  it("stops writing when collecting is off, and keeps the switch across restarts", async () => {
    const store = await open();
    store.count("approve");
    store.updateSettings({ collect: false });
    store.error("engine", "request", new Error("x"));
    store.warning("engine", "index_rebuilt");
    store.crash("desktop", "unclean_exit");
    store.report({ type: "usage", action: "expand_view" });
    store.close();
    expect(store.list().entries).toEqual([]);
    const again = await open();
    expect(again.settings().collect).toBe(false);
    again.error("engine", "request", new Error("x"));
    expect(again.list().entries).toEqual([]);
  });

  it("detects a crash by the marker a clean stop removes", async () => {
    let changes = 0;
    const first = await open();
    expect(first.crashedLastTime).toBe(false);
    expect(lstatSync(join(dir, RUNNING_FILE)).isFile()).toBe(true);
    // No close(): the engine died.
    const second = await open({ onChange: () => changes++ });
    expect(second.crashedLastTime).toBe(true);
    expect(second.list({ types: ["crash"] }).entries).toMatchObject([{ source: "engine", kind: "unclean_exit" }]);
    expect(second.settings().crashWaiting).toBe(true);
    expect(changes).toBe(1);
    clock.advance(1);
    expect(second.updateSettings({ crashSeen: true }).crashWaiting).toBe(false);
    second.close();
    expect(() => lstatSync(join(dir, RUNNING_FILE))).toThrow();
    const third = await open();
    expect(third.crashedLastTime).toBe(false);
    expect(third.settings().crashWaiting).toBe(false);
  });

  it("resets the install id on request and keeps it otherwise", async () => {
    const store = await open();
    const before = store.settings().installId;
    expect((await open()).settings().installId).toBe(before);
    const after = store.updateSettings({ resetInstallId: true }).installId;
    expect(after).not.toBe(before);
    expect(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"))).toMatchObject({ installId: after });
  });

  it("drops entries older than the age cap, and the oldest past the size cap", async () => {
    const store = await open({ maxBytes: 20_000 });
    store.warning("engine", "item_not_loaded");
    clock.advance(31 * DAY);
    store.warning("engine", "index_rebuilt");
    expect(store.list().entries.map((entry) => entry.type === "warning" && entry.code)).toEqual(["index_rebuilt"]);
    for (let i = 0; i < 100; i++) {
      clock.advance(1);
      store.error("engine", "request", new Error(`failure ${i}`));
    }
    const size = readFileSync(join(dir, ENTRIES_FILE)).length;
    expect(size).toBeLessThanOrEqual(20_000);
    const kept = store.list({ limit: 200 }).entries;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(0)?.at).toBe(clock.now());
    expect(lines()).toHaveLength(kept.length);
  });

  it("drops lines that do not parse, and starts anew from a file it cannot read", async () => {
    const store = await open();
    store.warning("engine", "index_rebuilt");
    store.close();
    writeFileSync(join(dir, ENTRIES_FILE), `${readFileSync(join(dir, ENTRIES_FILE), "utf8")}not json\n{"type":"error"}\n`);
    expect((await open()).list().entries).toHaveLength(1);
    expect(lines()).toHaveLength(1);
  });

  it("never writes through a planted symlink", async () => {
    const target = join(root, "elsewhere");
    writeFileSync(target, "keep\n");
    const store = await open();
    rmSync(join(dir, ENTRIES_FILE), { force: true });
    symlinkSync(target, join(dir, ENTRIES_FILE));
    store.warning("engine", "index_rebuilt");
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });
});
