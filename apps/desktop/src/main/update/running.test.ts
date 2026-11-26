import { describe, expect, it, vi } from "vitest";
import { runningNow, type RunningDeps } from "./running.js";

const close = vi.fn(async () => undefined);
function deps(over: Partial<RunningDeps> = {}): RunningDeps {
  return {
    lockPath: () => "/h/engine.lock",
    readLock: () => ({ pid: 10 }),
    pidAlive: () => true,
    connect: async () => ({ ok: true, value: { engine: { runningItems: 0 }, close } }),
    ...over,
  };
}

describe("runningNow", () => {
  it("gives the engine's own count and closes the client", async () => {
    close.mockClear();
    expect(await runningNow(deps({ connect: async () => ({ ok: true, value: { engine: { runningItems: 3 }, close } }) }))).toBe(3);
    expect(close).toHaveBeenCalledOnce();
  });

  it("is zero without a lock, or when its pid is gone", async () => {
    expect(await runningNow(deps({ readLock: () => undefined }))).toBe(0);
    expect(await runningNow(deps({ pidAlive: () => false }))).toBe(0);
  });

  it("is unknown when a live engine does not say, or cannot be reached", async () => {
    expect(await runningNow(deps({ connect: async () => ({ ok: true, value: { engine: {}, close } }) }))).toBeUndefined();
    expect(await runningNow(deps({ connect: async () => ({ ok: false, error: { code: "not_running" } as never }) }))).toBeUndefined();
    expect(await runningNow(deps({ connect: async () => { throw new Error("no"); } }))).toBeUndefined();
    expect(await runningNow(deps({ lockPath: () => undefined }))).toBeUndefined();
  });

  it("uses the count an engine of another API version gives with its refusal", async () => {
    const refused = { ok: false as const, error: { code: "unsupported_version" as const, engine: { apiVersion: 1, runningItems: 2 } } };
    expect(await runningNow(deps({ connect: async () => refused }))).toBe(2);
    expect(await runningNow(deps({ connect: async () => ({ ok: false, error: { code: "unsupported_version", engine: { apiVersion: 1 } } }) }))).toBeUndefined();
  });
});
