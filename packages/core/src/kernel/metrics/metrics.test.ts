import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../process/index.js";
import { createLinuxSource, createMacosSource, createMachineSource, parseCpuTime, parseMeminfo, parsePs, parseProcStat, parseStatusRss, parseVmStat } from "./index.js";

const fixture = (name: string) => readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url), "utf8");
const GIB = 1024 ** 3;

describe("macOS parsers, on output recorded from a Mac", () => {
  it("reads CPU time in the forms ps prints", () => {
    expect(parseCpuTime("0:00.50")).toBe(500);
    expect(parseCpuTime("234:18.51")).toBe(14_058_510);
    expect(parseCpuTime("1:02:03")).toBe(3_723_000);
    expect(parseCpuTime("2-01:00:00")).toBe(176_400_000);
    expect(parseCpuTime("soon")).toBeUndefined();
  });

  it("reads ps rows with rss in KiB and skips lines that do not fit", () => {
    const rows = parsePs(`${fixture("macos-ps.txt")}garbage line\n  9 1\n`);
    expect(rows).toHaveLength(13);
    expect(rows[0]).toEqual({ pid: 1, ppid: 0, pgid: 1, cpuMs: 822_170, rssBytes: 22496 * 1024 });
    expect(rows.at(-1)).toMatchObject({ pid: 423, pgid: 423, cpuMs: 14_058_510 });
  });

  it("computes used memory the way Activity Monitor does", () => {
    // (959635 anonymous - 19982 purgeable + 659570 wired + 560522 compressor) pages of 16 KiB
    const reading = parseVmStat(fixture("macos-vm_stat.txt"), 48 * GIB);
    expect(reading).toEqual({ totalBytes: 48 * GIB, usedBytes: (959635 - 19982 + 659570 + 560522) * 16384 });
  });

  it("returns nothing for output it does not know", () => {
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 5.\n", GIB)).toBeUndefined();
    expect(parseVmStat("", GIB)).toBeUndefined();
  });
});

describe("numbers too large to be exact", () => {
  it("are dropped instead of being passed on as rounded values", () => {
    expect(parsePs("99999999999999999999 1 1 100 0:01.00\n  5 1 1 100 0:01.00\n")).toHaveLength(1);
    expect(parseMeminfo("MemTotal: 99999999999999999999 kB\nMemAvailable: 1 kB\n")).toBeUndefined();
    expect(parseProcStat("5 (x) S 1 1 1 0 -1 0 0 0 0 0 99999999999999999999 1 0")).toBeUndefined();
    expect(parseStatusRss("VmRSS: 99999999999999999999 kB\n")).toBe(0);
  });
});

describe("Linux parsers", () => {
  it("reads meminfo; used is total minus available", () => {
    expect(parseMeminfo(fixture("linux-meminfo.txt"))).toEqual({ totalBytes: 16314432 * 1024, usedBytes: (16314432 - 10458112) * 1024 });
    expect(parseMeminfo("MemTotal: 5 kB\n")).toBeUndefined();
  });

  it("reads a process stat line and counts ticks as 10 ms", () => {
    expect(parseProcStat(fixture("linux-stat-node.txt"))).toEqual({ pid: 4242, ppid: 4100, pgid: 4242, cpuMs: (1523 + 311) * 10 });
  });

  it("finds the fields after a command name with spaces and parentheses", () => {
    expect(parseProcStat(fixture("linux-stat-parens.txt"))).toEqual({ pid: 777, ppid: 700, pgid: 700, cpuMs: 200 });
    expect(parseProcStat("not a stat line")).toBeUndefined();
  });

  it("reads VmRSS, and gives 0 for a kernel thread", () => {
    expect(parseStatusRss(fixture("linux-status-node.txt"))).toBe(164828 * 1024);
    expect(parseStatusRss(fixture("linux-status-kthread.txt"))).toBe(0);
  });
});

describe("the Linux source, on a fake /proc", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("lists numbered folders, skips one that vanishes, and reads memory", async () => {
    const proc = mkdtempSync(join(tmpdir(), "tokama-proc-"));
    dirs.push(proc);
    writeFileSync(join(proc, "meminfo"), fixture("linux-meminfo.txt"));
    mkdirSync(join(proc, "4242"));
    writeFileSync(join(proc, "4242", "stat"), fixture("linux-stat-node.txt"));
    writeFileSync(join(proc, "4242", "status"), fixture("linux-status-node.txt"));
    mkdirSync(join(proc, "99"));
    mkdirSync(join(proc, "self"));
    const source = createLinuxSource(proc);
    expect(await source.processes()).toEqual({ ok: true, value: [{ pid: 4242, ppid: 4100, pgid: 4242, cpuMs: 18340, rssBytes: 164828 * 1024 }] });
    expect(await source.memory()).toMatchObject({ ok: true, value: { totalBytes: 16314432 * 1024 } });
  });

  it("answers an error value when /proc is missing", async () => {
    const source = createLinuxSource(join(tmpdir(), "tokama-no-such-proc"));
    expect((await source.processes()).ok).toBe(false);
    expect((await source.memory()).ok).toBe(false);
  });
});

describe("the macOS source, with a fake process runner", () => {
  const runnerFor = (outputs: Record<string, string>, exitCode = 0): { runner: ProcessRunner; seen: RunRequest[] } => {
    const seen: RunRequest[] = [];
    return {
      seen,
      runner: {
        async run(request): Promise<RunResult> {
          seen.push(request);
          const argv = "argv" in request.command ? request.command.argv : [];
          for (const line of (outputs[argv[0] ?? ""] ?? "").split("\n")) request.stdout?.onLine?.(line);
          return { kind: "finished", pid: 5, exitCode, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 1, durationMs: 1 };
        },
      },
    };
  };

  it("runs vm_stat and ps by argv, never through a shell", async () => {
    const { runner, seen } = runnerFor({ "/usr/bin/vm_stat": fixture("macos-vm_stat.txt"), "/bin/ps": fixture("macos-ps.txt") });
    const source = createMacosSource(runner, () => 48 * GIB);
    expect(await source.memory()).toMatchObject({ ok: true, value: { totalBytes: 48 * GIB } });
    expect(await source.processes()).toMatchObject({ ok: true });
    expect(seen.map((r) => r.command)).toEqual([{ argv: ["/usr/bin/vm_stat"] }, { argv: ["/bin/ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "rss=", "-o", "time="] }]);
  });

  it("refuses output with more rows than a process table can have", async () => {
    const rows = Array.from({ length: 20_001 }, (_, i) => `${i + 2} 1 1 100 0:01.00`).join("\n");
    expect(await createMacosSource(runnerFor({ "/bin/ps": rows }).runner).processes()).toEqual({ ok: false, error: "/bin/ps printed more than 20000 lines" });
  });

  it("answers an error value when the command fails or prints something unknown", async () => {
    expect(await createMacosSource(runnerFor({}, 1).runner).processes()).toEqual({ ok: false, error: "/bin/ps failed with code 1" });
    expect((await createMacosSource(runnerFor({ "/usr/bin/vm_stat": "nothing useful" }).runner).memory()).ok).toBe(false);
  });
});

describe("createMachineSource", () => {
  const runner: ProcessRunner = { run: () => Promise.reject(new Error("not used")) };
  it("picks by platform, and has none for Windows", () => {
    expect(createMachineSource(runner, "darwin")).toBeDefined();
    expect(createMachineSource(runner, "linux")).toBeDefined();
    expect(createMachineSource(runner, "win32")).toBeUndefined();
  });
});
