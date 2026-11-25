import { describe, expect, it } from "vitest";
import { createProcessRunner } from "../process/index.js";
import { createMachineSource } from "./index.js";

// Runs the implementation for the OS this test runs on, so CI exercises each OS's own code.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("the machine source of this OS", () => {
  const source = createMachineSource(createProcessRunner());

  it("reads memory", async () => {
    const memory = await source?.memory();
    if (memory === undefined || !memory.ok) throw new Error(JSON.stringify(memory));
    expect(memory.value.totalBytes).toBeGreaterThan(0);
    expect(memory.value.usedBytes).toBeGreaterThan(0);
    expect(memory.value.usedBytes).toBeLessThanOrEqual(memory.value.totalBytes);
  });

  it("finds this process with its memory and its parent", async () => {
    const processes = await source?.processes();
    if (processes === undefined || !processes.ok) throw new Error(JSON.stringify(processes));
    const self = processes.value.find((p) => p.pid === process.pid);
    expect(self).toMatchObject({ ppid: process.ppid });
    expect(self?.rssBytes).toBeGreaterThan(1_000_000);
    expect(self?.cpuMs).toBeGreaterThan(0);
    expect(self?.pgid).toBeGreaterThan(0);
  });
});
