// Diagnostics through the real engine, socket and client: sentinels pushed in through the report
// command and through an engine catch site must never reach the diagnostics files or a reply.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import type { MachineFacts, ProcessTable } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { MemoryItemStore } from "./store.js";
import type { HealthChecks } from "./real/health.js";
import { tempEngineDir } from "./testing/helpers.js";

const table: ProcessTable = { list: async () => [], bootTime: () => Date.UTC(2026, 10, 1), signalGroup: () => undefined };
const MACHINE: MachineFacts = { os: "linux", osVersion: "24.04", distro: "ubuntu", arch: "x64", cpu: { family: "AMD Ryzen 7", cores: 16 }, ramGb: "16-32", gpu: null };
const USER_HOME = "/home/northwind-dev";
const EMAIL = "jane.doe@northwind.example";
const TOKEN = "ghp_SENTINEL0123456789abcdefghijklmnop";

let cleanups: (() => unknown)[] = [];
let root: string;
let home: string;
let repoPath: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tk-diag-")));
  home = join(root, "home");
  repoPath = join(root, "northwind-orders-checkout");
  mkdirSync(home);
  mkdirSync(repoPath);
  writeFileSync(join(home, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${repoPath}\n    base_branch: main\n    checks: []\n`);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** Fragments of every sentinel this file uses. */
const forbidden = () => ["northwind", "orders-api", "jane", "SENTINEL", "billing", root];

function expectClean(text: string): void {
  for (const fragment of forbidden()) expect(text, `"${fragment}" reached:\n${text}`).not.toContain(fragment);
}

function diagnosticsFiles(): string {
  const dir = join(home, "diagnostics");
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
}

async function engine(checks: HealthChecks = async () => ({ git: { ok: true }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.331" }] }), extra: { sample?: boolean; store?: MemoryItemStore } = {}) {
  const dir = tempEngineDir(cleanups);
  const started = await startEngine({ dir, home, processTable: table, checks, recoveryGraceMs: 0, planSources: {}, userHome: USER_HOME, machineFacts: MACHINE, engineVersion: "0.4.2", ...extra });
  if (!started.ok) throw new Error(started.error.message);
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  const client = connected.value;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await client.close();
    await started.value.close();
  };
  cleanups.push(stop);
  return { client, stop, dir };
}

async function list(client: EngineClient, query: { types?: ("error" | "warning" | "usage" | "crash")[] } = {}) {
  const reply = await client.query({ type: "diagnostics_list", ...query });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data;
}

const sentinelStack = () =>
  [
    `Error: cannot open ${repoPath}/src/billing.ts for ${EMAIL} with ${TOKEN}`,
    `    at render (file://${USER_HOME}/Library/Application Support/x.js:1:2)`,
    `    at build (https://deploy:hunter2@git.northwind.example/orders-api.git)`,
    "    at load (orders-api/src/billing/invoice.ts:3:4)",
  ].join("\n");

describe("engine diagnostics", () => {
  it("records a client's report cleaned: not in the file, not in the reply", async () => {
    const { client, stop } = await engine();
    const reported = await client.command({ type: "report_diagnostic", report: { type: "error", source: "renderer", where: "uncaught", stack: sentinelStack() }, appVersion: "0.4.2" });
    expect(reported).toEqual({ ok: true, data: null });
    const listed = await list(client);
    expectClean(JSON.stringify(listed));
    expect(listed.entries).toMatchObject([{ type: "error", source: "renderer", where: "uncaught", appVersion: "0.4.2", engineVersion: "0.4.2", machine: MACHINE }]);
    await stop();
    expectClean(diagnosticsFiles());
  });

  it("records an error the engine catches while answering, cleaned", async () => {
    // The board query reads the item store; this one fails with sentinels in its message.
    class FailingStore extends MemoryItemStore {
      override list(): never {
        throw new Error(`cannot read ${repoPath}/.git/config of ${EMAIL} (${TOKEN})`);
      }
    }
    const { client, stop } = await engine(undefined, { store: new FailingStore() });
    expect(await client.query({ type: "board" })).toMatchObject({ ok: false, error: { code: "internal" } });
    const errors = (await list(client, { types: ["error"] })).entries;
    expect(errors).toMatchObject([{ source: "engine", where: "request", name: "Error" }]);
    expectClean(JSON.stringify(errors));
    await stop();
    expectClean(diagnosticsFiles());
  });

  it("names the AI CLIs, counts usage commands and keeps the counts after a stop", async () => {
    const first = await engine();
    expect((await first.client.query({ type: "setup" })).ok).toBe(true);
    expect((await first.client.command({ type: "remove_repo", repoId: "orders-api" })).ok).toBe(true);
    await first.client.command({ type: "report_diagnostic", report: { type: "usage", action: "expand_view" } });
    await first.client.command({ type: "report_diagnostic", report: { type: "usage", action: "expand_view" } });
    await first.client.command({ type: "report_diagnostic", report: { type: "warning", source: "desktop", code: "renderer_unresponsive" } });
    await first.stop();
    const second = await engine();
    const usage = (await list(second.client, { types: ["usage"] })).entries;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ type: "usage", counts: expect.arrayContaining([{ action: "remove_repo", count: 1 }, { action: "expand_view", count: 2 }]) });
    const [warning] = (await list(second.client, { types: ["warning"] })).entries;
    expect(warning).toMatchObject({ code: "renderer_unresponsive", clis: [{ cliId: "claude-code", version: "2.1.331" }] });
    // A clean stop leaves no crash.
    expect((await list(second.client, { types: ["crash"] })).entries).toEqual([]);
  });

  it("turns off, deletes by ids and all, and flags a crash until it is seen", async () => {
    const { client } = await engine();
    await client.command({ type: "report_diagnostic", report: { type: "crash", source: "desktop", kind: "unclean_exit" } });
    const events: string[] = [];
    void (async () => {
      for await (const event of client.events()) if (event.kind === "event") events.push(event.event.type);
    })();
    const setup = await client.query({ type: "setup" });
    expect(setup.ok && setup.data.health.crashWaiting).toBe(true);
    const seen = await client.command({ type: "diagnostics_settings", crashSeen: true });
    expect(seen).toMatchObject({ ok: true, data: { collect: true, crashWaiting: false } });

    await client.command({ type: "report_diagnostic", report: { type: "warning", source: "desktop", code: "renderer_unresponsive" } });
    const all = (await list(client)).entries;
    expect(all).toHaveLength(2);
    expect(await client.command({ type: "diagnostics_delete", ids: [all[0]!.id] })).toEqual({ ok: true, data: { deleted: 1 } });
    expect(await client.command({ type: "diagnostics_delete" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await client.command({ type: "diagnostics_delete", all: true })).toEqual({ ok: true, data: { deleted: 1 } });

    expect(await client.command({ type: "diagnostics_settings", collect: false })).toMatchObject({ ok: true, data: { collect: false } });
    await client.command({ type: "report_diagnostic", report: { type: "error", source: "desktop", where: "uncaught", stack: "Error: x" } });
    expect((await list(client)).entries).toEqual([]);
    expect(await client.query({ type: "diagnostics_settings" })).toMatchObject({ ok: true, data: { collect: false, crashWaiting: false } });
    expect(events).toContain("setup_changed");
  });

  it("keeps sample entries of every type in sample mode, in its engine dir and never in the Tokama home", async () => {
    const { client, dir } = await engine(undefined, { sample: true });
    const entries = (await list(client)).entries;
    expect(new Set(entries.map((entry) => entry.type))).toEqual(new Set(["error", "warning", "usage", "crash"]));
    // The sample crash is seen: no prompt until the sample engine really dies.
    expect(await client.query({ type: "diagnostics_settings" })).toMatchObject({ ok: true, data: { collect: true, crashWaiting: false } });
    expect(readdirSync(join(dir, "diagnostics"))).toContain("entries.jsonl");
    expect(readdirSync(home)).not.toContain("diagnostics");
  });

  it("tells clients when entries are recorded or deleted", async () => {
    const { client } = await engine();
    const events: string[] = [];
    void (async () => {
      for await (const event of client.events()) if (event.kind === "event") events.push(event.event.type);
    })();
    await client.command({ type: "report_diagnostic", report: { type: "warning", source: "desktop", code: "renderer_unresponsive" } });
    await expect.poll(() => events.filter((type) => type === "diagnostics_changed").length).toBe(1);
    await client.command({ type: "diagnostics_delete", all: true });
    await expect.poll(() => events.filter((type) => type === "diagnostics_changed").length).toBe(2);
  });
});
