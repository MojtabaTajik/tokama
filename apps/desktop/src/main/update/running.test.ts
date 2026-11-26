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
  it("gives the engine's own count and API version, and closes the client", async () => {
    close.mockClear();
    expect(await runningNow(deps({ connect: async () => ({ ok: true, value: { engine: { apiVersion: 15, runningItems: 3 }, close } }) }))).toEqual({ items: 3, apiVersion: 15 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("is zero without a lock, or when its pid is gone, and names no engine", async () => {
    expect(await runningNow(deps({ readLock: () => undefined }))).toEqual({ items: 0 });
    expect(await runningNow(deps({ pidAlive: () => false }))).toEqual({ items: 0 });
  });

  it("is unknown when a live engine does not say, or cannot be reached", async () => {
    expect(await runningNow(deps({ connect: async () => ({ ok: true, value: { engine: {}, close } }) }))).toEqual({ items: undefined });
    expect(await runningNow(deps({ connect: async () => ({ ok: false, error: { code: "not_running" } as never }) }))).toEqual({ items: undefined });
    expect(await runningNow(deps({ connect: async () => { throw new Error("no"); } }))).toEqual({ items: undefined });
    expect(await runningNow(deps({ lockPath: () => undefined }))).toEqual({ items: undefined });
  });

  it("uses the count and the API version an engine of another API version gives with its refusal", async () => {
    const refused = { ok: false as const, error: { code: "unsupported_version" as const, engine: { apiVersion: 1, runningItems: 2 } } };
    expect(await runningNow(deps({ connect: async () => refused }))).toEqual({ items: 2, apiVersion: 1 });
    expect(await runningNow(deps({ connect: async () => ({ ok: false, error: { code: "unsupported_version", engine: { apiVersion: 1 } } }) }))).toEqual({ items: undefined, apiVersion: 1 });
  });
});
