// Turns two readings of the machine into the numbers a client shows. Pure: no clock, no OS.
import type { MemoryReading, ProcessReading } from "../../kernel/metrics/index.js";
import type { ItemId, ItemProcessSetUsage, MachinePoint, ProcessSetUsage } from "../../kernel/schemas/index.js";

/** CPU time of all cores since boot, in ms. */
export interface CpuTimes {
  readonly idleMs: number;
  readonly totalMs: number;
}

export interface Reading {
  readonly at: number;
  readonly cpu: CpuTimes;
  readonly memory: MemoryReading;
  readonly processes: readonly ProcessReading[];
}

/** A process group a running item owns: the agent's, or one check's. The group id is its root's pid. */
export interface ItemGroup {
  readonly itemId: ItemId;
  readonly title: string;
  readonly role: "agent" | "check";
  readonly pgid: number;
}

export interface Measure {
  readonly point: MachinePoint;
  readonly engine: ProcessSetUsage;
  readonly items: ItemProcessSetUsage[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The group's processes: its members by group id, and everything below them by parent, since
 * agents start shell commands in groups of their own.
 */
function members(processes: readonly ProcessReading[], pgid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of processes) {
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const found = new Set<number>();
  const queue = processes.filter((p) => p.pgid === pgid).map((p) => p.pid);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (found.has(next)) continue;
    found.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}

export function measure(prev: Reading, cur: Reading, groups: readonly ItemGroup[], enginePid: number): Measure {
  const elapsedMs = Math.max(1, cur.at - prev.at);
  const before = new Map(prev.processes.map((p) => [p.pid, p.cpuMs]));
  const byPid = new Map(cur.processes.map((p) => [p.pid, p]));
  // A process that is new since the last reading used all its CPU time within the interval.
  const cpuUsed = (p: ProcessReading) => {
    const was = before.get(p.pid);
    return was === undefined || p.cpuMs < was ? p.cpuMs : p.cpuMs - was;
  };
  const usageOf = (pids: Iterable<number>): ProcessSetUsage => {
    let cpuMs = 0;
    let memoryBytes = 0;
    let processes = 0;
    for (const pid of pids) {
      const p = byPid.get(pid);
      if (p === undefined) continue;
      cpuMs += cpuUsed(p);
      memoryBytes += p.rssBytes;
      processes += 1;
    }
    return { cpuPercent: round1((cpuMs / elapsedMs) * 100), memoryBytes: Math.round(memoryBytes), processes };
  };

  const claimed = new Set<number>([enginePid]);
  const items: ItemProcessSetUsage[] = [];
  for (const group of groups) {
    const own = [...members(cur.processes, group.pgid)].filter((pid) => !claimed.has(pid));
    own.forEach((pid) => claimed.add(pid));
    // A group with no live process is not listed: its check or agent has ended.
    const usage = usageOf(own);
    if (usage.processes > 0) items.push({ itemId: group.itemId, title: group.title, role: group.role, ...usage });
  }
  const engine = usageOf([enginePid]);

  const dTotal = cur.cpu.totalMs - prev.cpu.totalMs;
  const dIdle = cur.cpu.idleMs - prev.cpu.idleMs;
  const busy = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
  const tokama = [engine, ...items];
  return {
    point: {
      at: cur.at,
      cpuPercent: round1(Math.min(100, Math.max(0, busy))),
      memoryUsedBytes: Math.round(cur.memory.usedBytes),
      tokamaCpuPercent: round1(tokama.reduce((sum, u) => sum + u.cpuPercent, 0)),
      tokamaMemoryBytes: tokama.reduce((sum, u) => sum + u.memoryBytes, 0),
    },
    engine,
    items,
  };
}
