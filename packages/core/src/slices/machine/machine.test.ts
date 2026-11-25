import { describe, expect, it } from "vitest";
import { manualClock } from "../../kernel/clock/index.js";
import type { MachineSource, ProcessReading } from "../../kernel/metrics/index.js";
import { err, ok } from "../../kernel/result/index.js";
import { MachineReportSchema, type ItemId } from "../../kernel/schemas/index.js";
import { createMonitor, measure, type Host, type ItemGroup, type Reading } from "./index.js";

const ITEM = "item_0190a000-0000-7000-8000-00000000000a" as ItemId;
const GIB = 1024 ** 3;
const proc = (pid: number, ppid: number, pgid: number, cpuMs: number, rssBytes = 100): ProcessReading => ({ pid, ppid, pgid, cpuMs, rssBytes });
const reading = (at: number, cpu: { idleMs: number; totalMs: number }, processes: readonly ProcessReading[], usedBytes = 8 * GIB): Reading => ({ at, cpu, memory: { totalBytes: 16 * GIB, usedBytes }, processes });

describe("measure", () => {
  const prev = reading(0, { idleMs: 0, totalMs: 0 }, [proc(10, 1, 10, 1000), proc(500, 10, 500, 0), proc(600, 1, 600, 5000)]);

  it("reads overall CPU from the change in idle and total time", () => {
    const cur = reading(1000, { idleMs: 3000, totalMs: 4000 }, prev.processes);
    expect(measure(prev, cur, [], 600).point.cpuPercent).toBe(25);
  });

  it("is 0 when no CPU time passed, and never above 100", () => {
    expect(measure(prev, reading(1000, { idleMs: 0, totalMs: 0 }, []), [], 1).point.cpuPercent).toBe(0);
    expect(measure(prev, reading(1000, { idleMs: -50, totalMs: 100 }, []), [], 1).point.cpuPercent).toBe(100);
  });

  it("gives a group's CPU as percent of one core, counting its members and what they started", () => {
    const cur = reading(
      1000,
      { idleMs: 0, totalMs: 1 },
      [proc(10, 1, 10, 1500, 1000), proc(500, 10, 500, 400, 2000), proc(501, 500, 501, 200, 4000), proc(600, 1, 600, 5300, 50)],
    );
    const group: ItemGroup = { itemId: ITEM, title: "Fix it", role: "agent", pgid: 10 };
    const m = measure(prev, cur, [group], 600);
    // 500 + 400 + 200 (new, so its whole time) ms in 1000 ms
    expect(m.items).toEqual([{ itemId: ITEM, title: "Fix it", role: "agent", cpuPercent: 110, memoryBytes: 7000, processes: 3 }]);
    expect(m.engine).toEqual({ cpuPercent: 30, memoryBytes: 50, processes: 1 });
    expect(m.point).toMatchObject({ tokamaCpuPercent: 140, tokamaMemoryBytes: 7050 });
  });

  it("keeps a group's member that left the group, and counts a process once", () => {
    const cur = reading(1000, { idleMs: 0, totalMs: 1 }, [proc(10, 1, 10, 1000, 10), proc(500, 10, 500, 0, 20), proc(10_000, 10, 10, 0, 30)]);
    const groups: ItemGroup[] = [
      { itemId: ITEM, title: "a", role: "agent", pgid: 10 },
      { itemId: ITEM, title: "a", role: "check", pgid: 500 },
    ];
    const m = measure(prev, cur, groups, 600);
    expect(m.items.map((i) => [i.role, i.processes, i.memoryBytes])).toEqual([["agent", 3, 60]]);
  });

  it("leaves out a group with no live process, and a process that restarted counts its whole time", () => {
    const cur = reading(1000, { idleMs: 0, totalMs: 1 }, [proc(600, 1, 600, 200)]);
    const m = measure(prev, cur, [{ itemId: ITEM, title: "a", role: "check", pgid: 777 }], 600);
    expect(m.items).toEqual([]);
    expect(m.engine.cpuPercent).toBe(20);
  });
});

describe("the monitor", () => {
  // A source and host whose numbers move on each reading: 1 s of CPU time and 1 s of wall time pass.
  const setup = (options: { fail?: { memory?: boolean } } = {}) => {
    const clock = manualClock(1_000_000);
    let calls = 0;
    const source: MachineSource = {
      memory: async () => (options.fail?.memory === true ? err("vm_stat failed") : ok({ totalBytes: 16 * GIB, usedBytes: 4 * GIB })),
      processes: async () => ok([proc(42, 1, 42, calls * 500, 1000)]),
    };
    const host: Host = {
      cpuTimes: () => ({ idleMs: calls * 1000, totalMs: (calls + 1) * 1000 }),
      loadAverage: () => [1, 2, 3],
      cores: () => 8,
    };
    const counted: MachineSource = { ...source, processes: async () => { calls++; return source.processes(); } };
    const monitor = createMonitor({ source: counted, host, clock, enginePid: 42, groups: () => [], everyMs: 5000, historyMs: 20_000, idleMs: 12_000, warmupMs: 100 });
    return { clock, monitor, reads: () => calls };
  };
  // Lets the monitor's awaits finish, then moves the manual clock.
  const tick = async (clock: ReturnType<typeof manualClock>, ms: number) => {
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };

  it("answers the first request after one warm-up with a report that fits the schema", async () => {
    const { clock, monitor } = setup();
    const pending = monitor.report();
    await tick(clock, 100);
    const report = await pending;
    if (!report.ok) throw new Error(report.error);
    expect(MachineReportSchema.safeParse(report.value).success).toBe(true);
    expect(report.value).toMatchObject({ everyMs: 5000, cores: 8, memoryTotalBytes: 16 * GIB, load: [1, 2, 3], engine: { processes: 1 } });
    expect(report.value.points).toHaveLength(1);
    expect(report.value.points[0]).toMatchObject({ memoryUsedBytes: 4 * GIB });
    await monitor.close();
  });

  it("keeps sampling while asked, trims the history, and stops once nobody asks", async () => {
    const { clock, monitor, reads } = setup();
    const pending = monitor.report();
    await tick(clock, 100);
    await pending;
    for (let i = 0; i < 2; i++) {
      await tick(clock, 5000);
      await monitor.report();
    }
    const sampled = await monitor.report();
    if (!sampled.ok) throw new Error(sampled.error);
    expect(sampled.value.points).toHaveLength(3);
    const asked = reads();
    expect(asked).toBeGreaterThanOrEqual(4);
    // Nobody asks: one more reading at most, then nothing.
    for (let i = 0; i < 8; i++) await tick(clock, 5000);
    const afterIdle = reads();
    for (let i = 0; i < 4; i++) await tick(clock, 5000);
    expect(reads()).toBe(afterIdle);
    expect(afterIdle - asked).toBeLessThanOrEqual(3);
    // History is trimmed to historyMs, and a new request starts the loop again.
    const again = monitor.report();
    await tick(clock, 100);
    await tick(clock, 100);
    const report = await again;
    if (!report.ok) throw new Error(report.error);
    expect(report.value.points.every((p) => p.at >= clock.now() - 20_000 - 5000)).toBe(true);
    await monitor.close();
  });

  it("answers an error value when the first reading fails, and tries again on the next request", async () => {
    const { monitor, clock } = setup({ fail: { memory: true } });
    expect(await monitor.report()).toEqual({ ok: false, error: "vm_stat failed" });
    await tick(clock, 0);
    expect((await monitor.report()).ok).toBe(false);
    await monitor.close();
  });

  it("recovers when the first sample fails after a good baseline", async () => {
    const clock = manualClock(1_000_000);
    let memoryCalls = 0;
    const source: MachineSource = {
      // The baseline (call 1) works, the first sample (call 2) fails, the next ones work.
      memory: async () => (++memoryCalls === 2 ? err("busy") : ok({ totalBytes: 16 * GIB, usedBytes: GIB })),
      processes: async () => ok([proc(42, 1, 42, 0)]),
    };
    const host: Host = { cpuTimes: () => ({ idleMs: 0, totalMs: 1 }), loadAverage: () => [0, 0, 0], cores: () => 2 };
    const monitor = createMonitor({ source, host, clock, enginePid: 42, groups: () => [], everyMs: 5000, warmupMs: 100 });
    const first = monitor.report();
    await tick(clock, 100);
    expect(await first).toEqual({ ok: false, error: "busy" });
    await tick(clock, 5000);
    const second = await monitor.report();
    expect(second.ok && second.value.points).toHaveLength(1);
    await monitor.close();
  });

  it("closes during the warm-up without waiting for it", async () => {
    const { monitor, clock } = setup();
    const pending = monitor.report();
    await tick(clock, 0);
    await monitor.close();
    expect((await pending).ok).toBe(false);
  });

  it("waits for a new reading when the old ones are from before the loop stopped", async () => {
    const { clock, monitor } = setup();
    const first = monitor.report();
    await tick(clock, 100);
    await first;
    for (let i = 0; i < 6; i++) await tick(clock, 5000);
    const before = clock.now();
    const again = monitor.report();
    await tick(clock, 100);
    await tick(clock, 100);
    const report = await again;
    expect(report.ok && report.value.asOf).toBeGreaterThan(before);
    await monitor.close();
  });

  it("keeps at most 1000 points, however long the history window", async () => {
    const clock = manualClock(1_000_000);
    const source: MachineSource = { memory: async () => ok({ totalBytes: GIB, usedBytes: 1 }), processes: async () => ok([proc(42, 1, 42, 0)]) };
    const host: Host = { cpuTimes: () => ({ idleMs: 0, totalMs: 1 }), loadAverage: () => [0, 0, 0], cores: () => 1 };
    const monitor = createMonitor({ source, host, clock, enginePid: 42, groups: () => [], everyMs: 10, historyMs: 3_600_000, idleMs: 10_000_000, warmupMs: 1 });
    const first = monitor.report();
    await tick(clock, 1);
    await first;
    for (let i = 0; i < 1100; i++) await tick(clock, 10);
    const report = await monitor.report();
    expect(report.ok && report.value.points).toHaveLength(1000);
    await monitor.close();
  });

  it("answers an error after close", async () => {
    const { monitor } = setup();
    await monitor.close();
    expect((await monitor.report()).ok).toBe(false);
  });
});
