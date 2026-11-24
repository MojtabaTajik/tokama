import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../clock/index.js";
import { killLeftoverTree, parsePsOutput, posixProcessTable, type ProcessInfo, type ProcessTable } from "./leftover.js";
import type { TreeSignal } from "./runner.js";

const BOOT = Date.UTC(2026, 10, 23, 8, 0, 0);
const START = Date.UTC(2026, 10, 24, 10, 0, 0);
const SELF = 900;

/** A process table in memory. A signalled group's processes die unless they ignore the signal. */
function fakeTable(processes: ProcessInfo[], options: { ignoreTerm?: number[]; bootTime?: number } = {}) {
  let live = [...processes];
  const signals: Array<[number, TreeSignal]> = [];
  const table: ProcessTable = {
    list: async () => [...live],
    bootTime: () => options.bootTime ?? BOOT,
    signalGroup(pgid, signal) {
      signals.push([pgid, signal]);
      live = live.filter((p) => p.pgid !== pgid || (signal === "SIGTERM" && options.ignoreTerm?.includes(p.pid)));
    },
  };
  return { table, signals, alive: () => live.map((p) => p.pid) };
}

const proc = (pid: number, ppid: number, pgid: number, startedAt = START): ProcessInfo => ({ pid, ppid, pgid, startedAt });
// The engine (900, its own group), an unrelated process (50), and an agent tree rooted at 100:
// a child in the agent's group (101) and two shell commands in their own groups (110, 120),
// each with a child (111, 121).
const world = () => [
  proc(1, 0, 1, BOOT),
  proc(SELF, 1, SELF),
  proc(50, 1, 50),
  proc(100, 1, 100),
  proc(101, 100, 100),
  proc(110, 100, 110),
  proc(111, 110, 110),
  proc(120, 101, 120),
  proc(121, 120, 120),
];
const record = { pid: 100, startedAt: START + 400, bootTime: BOOT };

async function run(table: ProcessTable, rec = record) {
  const clock = manualClock(START + 60_000);
  const done = killLeftoverTree(rec, { table, clock, graceMs: 2_000, selfPid: SELF });
  // Let the first table read finish, then pass the grace period.
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(2_000);
  return done;
}

describe("killLeftoverTree", () => {
  it("signals every process group in the tree with SIGTERM, and leaves other processes alone", async () => {
    const { table, signals, alive } = fakeTable(world());
    const outcome = await run(table);
    expect(outcome).toEqual({ kind: "killed", groups: [100, 110, 120], forced: [] });
    expect(signals).toEqual([
      [100, "SIGTERM"],
      [110, "SIGTERM"],
      [120, "SIGTERM"],
    ]);
    expect(alive()).toEqual([1, SELF, 50]);
  });

  it("sends SIGKILL after the grace period only to groups that still hold a process of the tree", async () => {
    const { table, signals, alive } = fakeTable(world(), { ignoreTerm: [111] });
    const outcome = await run(table);
    expect(outcome).toEqual({ kind: "killed", groups: [100, 110, 120], forced: [110] });
    expect(signals.at(-1)).toEqual([110, "SIGKILL"]);
    expect(alive()).toEqual([1, SELF, 50]);
  });

  it("does not SIGKILL a group whose id was reused by other processes during the grace period", async () => {
    const { table, signals } = fakeTable(world());
    const list = table.list.bind(table);
    let reads = 0;
    table.list = async () => (++reads === 1 ? list() : [...(await list()), proc(110, 1, 110, START + 61_000)]);
    const outcome = await run(table);
    expect(outcome).toEqual({ kind: "killed", groups: [100, 110, 120], forced: [] });
    expect(signals.some(([, signal]) => signal === "SIGKILL")).toBe(false);
  });

  it("skips a pid that now belongs to a process started at another time", async () => {
    const { table, signals } = fakeTable(world());
    expect(await run(table, { ...record, startedAt: START - 3_600_000 })).toEqual({ kind: "skipped", reason: "pid_reused" });
    expect(signals).toEqual([]);
  });

  it("skips when the machine booted since the record", async () => {
    const { table, signals } = fakeTable(world(), { bootTime: BOOT + 86_400_000 });
    expect(await run(table)).toEqual({ kind: "skipped", reason: "rebooted" });
    expect(signals).toEqual([]);
  });

  it("skips a pid that is gone", async () => {
    const { table, signals } = fakeTable(world());
    expect(await run(table, { ...record, pid: 4242 })).toEqual({ kind: "skipped", reason: "gone" });
    expect(signals).toEqual([]);
  });

  it("never signals pid 1, the engine itself, or the engine's own group", async () => {
    for (const pid of [1, SELF]) {
      const { table, signals } = fakeTable(world());
      expect(await run(table, { ...record, pid })).toEqual({ kind: "skipped", reason: "unsafe" });
      expect(signals).toEqual([]);
    }
    // A tree member in the engine's group: its group is not signalled.
    const { table, signals } = fakeTable([...world(), proc(130, 100, SELF)]);
    await run(table);
    expect(signals.map(([pgid]) => pgid)).not.toContain(SELF);
  });

  it("skips a tree that contains the engine", async () => {
    const { table, signals } = fakeTable(world().map((p) => (p.pid === SELF ? proc(SELF, 101, SELF) : p)));
    expect(await run(table)).toEqual({ kind: "skipped", reason: "unsafe" });
    expect(signals).toEqual([]);
  });
});

describe("parsePsOutput", () => {
  it("reads pid, ppid, pgid and the UTC start time", () => {
    const output = ["    1     0     1 Mon Nov 23 08:15:49 2026    ", "  350     1   350 Tue Nov  3 18:06:07 2026", "garbage", ""].join("\n");
    expect(parsePsOutput(output)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, startedAt: Date.UTC(2026, 10, 23, 8, 15, 49) },
      { pid: 350, ppid: 1, pgid: 350, startedAt: Date.UTC(2026, 10, 3, 18, 6, 7) },
    ]);
  });
});

describe.skipIf(process.platform === "win32")("posixProcessTable", () => {
  const pids: number[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("kills a real leftover tree, including a child in its own process group", { timeout: 20_000 }, async () => {
    // The root starts a child in a new group (detached), as an agent's shell commands are.
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: "ignore" });
      console.log(child.pid);
      setTimeout(() => {}, 20000);`;
    const startedAt = Date.now();
    const root = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const rootPid = root.pid ?? 0;
    pids.push(rootPid);
    const childPid = await new Promise<number>((resolve) => root.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
    pids.push(childPid);

    const before = await posixProcessTable.list();
    expect(before.find((p) => p.pid === childPid)?.pgid).toBe(childPid);
    expect(Math.abs((before.find((p) => p.pid === rootPid)?.startedAt ?? 0) - startedAt)).toBeLessThan(2_000);

    const outcome = await killLeftoverTree({ pid: rootPid, startedAt, bootTime: posixProcessTable.bootTime() }, { table: posixProcessTable, graceMs: 500 });
    expect(outcome).toMatchObject({ kind: "killed", groups: [rootPid, childPid] });
    await new Promise((resolve) => (root.exitCode !== null || root.signalCode !== null ? resolve(null) : root.once("exit", resolve)));
    // The child was reparented to pid 1 when the root died; it still got the signal.
    const deadline = Date.now() + 5_000;
    while (isAlive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(childPid)).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
