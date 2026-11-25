import { readdir, readFile } from "node:fs/promises";
import { err, ok } from "../result/index.js";
import type { MachineSource, MemoryReading, ProcessReading } from "./types.js";

// The kernel counts process CPU time in ticks of 1/100 s on every Linux build (USER_HZ).
const MS_PER_TICK = 10;

/** Parses `/proc/meminfo`. Used is total minus what the kernel calls available (free plus reclaimable cache). */
export function parseMeminfo(text: string): MemoryReading | undefined {
  const kib = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
    const bytes = match === null ? undefined : Number(match[1]) * 1024;
    return bytes !== undefined && Number.isSafeInteger(bytes) ? bytes : undefined;
  };
  const total = kib("MemTotal");
  const available = kib("MemAvailable");
  if (total === undefined || available === undefined) return undefined;
  return { totalBytes: total, usedBytes: Math.max(0, total - available) };
}

/**
 * Parses `/proc/<pid>/stat`. The command name is in parentheses and may hold spaces and
 * parentheses, so the fields are counted from the last `)`. Resident memory is not read here.
 */
export function parseProcStat(text: string): Omit<ProcessReading, "rssBytes"> | undefined {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open));
  // After the name: state, ppid, pgrp, session, tty, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime.
  const fields = text.slice(close + 2).trim().split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (![pid, ppid, pgid, utime, stime].every(Number.isSafeInteger)) return undefined;
  return { pid, ppid, pgid, cpuMs: (utime + stime) * MS_PER_TICK };
}

/** The `VmRSS` line of `/proc/<pid>/status`; a kernel thread has none. */
export function parseStatusRss(text: string): number {
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(text);
  const bytes = match === null ? 0 : Number(match[1]) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : 0;
}

/** Reads `/proc`; it starts no command. */
export function createLinuxSource(proc = "/proc"): MachineSource {
  return {
    async memory() {
      try {
        const reading = parseMeminfo(await readFile(`${proc}/meminfo`, "utf8"));
        return reading === undefined ? err("/proc/meminfo is in an unknown form") : ok(reading);
      } catch (error) {
        return err(`cannot read /proc/meminfo: ${String(error)}`);
      }
    },
    async processes() {
      let names: string[];
      try {
        names = (await readdir(proc)).filter((name) => /^\d+$/.test(name));
      } catch (error) {
        return err(`cannot read /proc: ${String(error)}`);
      }
      const rows = await Promise.all(
        names.map(async (name): Promise<ProcessReading | undefined> => {
          try {
            const stat = parseProcStat(await readFile(`${proc}/${name}/stat`, "utf8"));
            if (stat === undefined) return undefined;
            return { ...stat, rssBytes: parseStatusRss(await readFile(`${proc}/${name}/status`, "utf8")) };
          } catch {
            // The process ended between the listing and the read, or belongs to another user.
            return undefined;
          }
        }),
      );
      return ok(rows.filter((row): row is ProcessReading => row !== undefined));
    },
  };
}
