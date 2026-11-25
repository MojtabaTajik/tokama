import { describe, expect, it, vi } from "vitest";
import { cachedChecks, type HealthChecks } from "./health.js";

const healthy = { git: { ok: true }, clis: [] };

describe("cachedChecks", () => {
  it("runs the checks once while the result is fresh, and again once it is older than the limit", async () => {
    let now = 1_000;
    const checks = vi.fn<HealthChecks>(async () => healthy);
    const cached = cachedChecks(checks, () => now, 5_000);
    await Promise.all([cached.get(), cached.get()]);
    now += 5_000;
    await cached.get();
    expect(checks).toHaveBeenCalledTimes(1);
    now += 1;
    await cached.get();
    expect(checks).toHaveBeenCalledTimes(2);
  });

  it("turns checks that throw into a git problem instead of a failed setup", async () => {
    const cached = cachedChecks(async () => Promise.reject(new Error("spawn failed")), () => 0);
    expect(await cached.get()).toEqual({ git: { ok: false, message: "The checks failed: Error: spawn failed" }, clis: [] });
  });
});
