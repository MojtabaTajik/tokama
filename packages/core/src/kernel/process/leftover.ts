// Kills an agent's process tree that outlived the engine (a crash or restart while a step ran).
//
// A recorded pid can belong to another process by now: after a reboot, or after the pid wrapped
// around. So the kill happens only when the boot time and the pid's start time both match the
// record. The tree is read once, while it is still whole, and every process group in it is
// signalled: agents such as Claude Code start each shell command in its own group, so signalling
// the root's group alone would leave those running, reparented to pid 1.
import { execFile } from "node:child_process";
import { uptime } from "node:os";
import { systemClock, type Clock } from "../clock/index.js";
import { posixTree } from "./posix.js";
import type { TreeSignal } from "./runner.js";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Start time, epoch ms, to the second. */
  readonly startedAt: number;
}

/** The OS-specific part: read the process table, the boot time, signal a group. One per OS. */
export interface ProcessTable {
  list(): Promise<ProcessInfo[]>;
  /** Epoch ms. */
  bootTime(): number;
  /** Never throws for a group that is already gone. */
  signalGroup(pgid: number, signal: TreeSignal): void;
}

export interface LeftoverRecord {
  readonly pid: number;
  /** When the process started, as recorded when it was spawned. */
  readonly startedAt: number;
  /** The boot time recorded when it was spawned. */
  readonly bootTime: number;
}

export type LeftoverOutcome =
  | { readonly kind: "killed"; readonly groups: readonly number[]; readonly forced: readonly number[] }
  | { readonly kind: "skipped"; readonly reason: "gone" | "rebooted" | "pid_reused" | "unsafe" };

export interface KillLeftoverOptions {
  readonly table: ProcessTable;
  readonly clock?: Clock;
  /** Time between SIGTERM and SIGKILL. */
  readonly graceMs?: number;
  /** This process; its own group is never signalled. */
  readonly selfPid?: number;
}

// ps reports start times to the second; the spawn is recorded within milliseconds of it.
const START_TOLERANCE_MS = 5_000;
// The boot time is derived from the wall clock and the uptime, so it drifts with clock changes.
const BOOT_TOLERANCE_MS = 60_000;

export async function killLeftoverTree(record: LeftoverRecord, options: KillLeftoverOptions): Promise<LeftoverOutcome> {
  const { table } = options;
  const clock = options.clock ?? systemClock;
  const selfPid = options.selfPid ?? process.pid;
  if (!Number.isInteger(record.pid) || record.pid <= 1 || record.pid === selfPid) return { kind: "skipped", reason: "unsafe" };
  if (Math.abs(table.bootTime() - record.bootTime) > BOOT_TOLERANCE_MS) return { kind: "skipped", reason: "rebooted" };

  const snapshot = await table.list();
  const root = snapshot.find((p) => p.pid === record.pid);
  if (root === undefined) return { kind: "skipped", reason: "gone" };
  if (Math.abs(root.startedAt - record.startedAt) > START_TOLERANCE_MS) return { kind: "skipped", reason: "pid_reused" };

  const tree = descendants(snapshot, root);
  if (tree.some((p) => p.pid === selfPid)) return { kind: "skipped", reason: "unsafe" };
  const selfGroup = snapshot.find((p) => p.pid === selfPid)?.pgid;
  const groups = [...new Set(tree.map((p) => p.pgid))].filter((pgid) => pgid > 1 && pgid !== selfGroup);
  const members = new Set(tree.map(identity));

  for (const pgid of groups) table.signalGroup(pgid, "SIGTERM");
  await new Promise<void>((resolve) => clock.setTimeout(resolve, options.graceMs ?? 2_000));

  // Only groups that still hold a process of the tree (same pid and start time) get SIGKILL, so
  // a group id reused meanwhile is left alone.
  const after = await table.list();
  const forced = groups.filter((pgid) => after.some((p) => p.pgid === pgid && members.has(identity(p))));
  for (const pgid of forced) table.signalGroup(pgid, "SIGKILL");
  return { kind: "killed", groups, forced };
}

function descendants(snapshot: readonly ProcessInfo[], root: ProcessInfo): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const p of snapshot) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const tree: ProcessInfo[] = [];
  const seen = new Set<number>();
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    tree.push(next);
    queue.push(...(children.get(next.pid) ?? []));
  }
  return tree;
}

const identity = (p: ProcessInfo) => `${p.pid}@${p.startedAt}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `Mon Nov 23 08:16:27 2026`: ps's lstart in the C locale. */
export const LSTART = "[A-Z][a-z]{2}\\s+[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}";
const LSTART_PARTS = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;
// `  350     1   350 Mon Nov 23 08:16:27 2026`: pid, ppid, pgid, then lstart.
const PS_LINE = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${LSTART})\\s*$`);

/** Epoch ms of a ps lstart printed with `TZ=UTC LC_ALL=C`; undefined when it is not one. */
export function parseLstart(text: string): number | undefined {
  const match = LSTART_PARTS.exec(text.trim());
  if (match === null) return undefined;
  const [, month, day, hours, minutes, seconds, year] = match;
  const monthIndex = MONTHS.indexOf(month ?? "");
  if (monthIndex < 0) return undefined;
  return Date.UTC(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds));
}

/** Parses `ps -A -o pid= -o ppid= -o pgid= -o lstart=` output, run with `TZ=UTC LC_ALL=C`. */
export function parsePsOutput(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pgid, lstart] = match;
    const startedAt = parseLstart(lstart ?? "");
    if (startedAt === undefined) continue;
    processes.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startedAt });
  }
  return processes;
}

/** macOS and Linux. */
export const posixProcessTable: ProcessTable = {
  list() {
    return new Promise((resolve, reject) => {
      execFile(
        "ps",
        ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart="],
        { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(parsePsOutput(stdout))),
      );
    });
  },
  bootTime: () => Date.now() - Math.round(uptime() * 1000),
  signalGroup: (pgid, signal) => posixTree.signalTree(pgid, signal),
};
