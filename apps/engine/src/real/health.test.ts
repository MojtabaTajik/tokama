import { writeFileSync } from "node:fs";
import type { ProcessRunner } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import { cachedChecks, type HealthChecks, machineChecks } from "./health.js";

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

  it("turns checks that throw into a git problem and an unknown Claude Code, not a failed setup", async () => {
    const cached = cachedChecks(async () => Promise.reject(new Error("spawn failed")), () => 0);
    const message = "The checks failed: Error: spawn failed";
    expect(await cached.get()).toEqual({ git: { ok: false, message }, clis: [{ cliId: "claude-code", installed: false, loggedIn: false, timedOut: true, message }] });
  });
});

describe("machineChecks: git", () => {
  /** A runner whose git prints `output` (nothing when it is undefined: git is missing) and whose other tools are missing. */
  const runnerWithGit = (output: string | undefined): ProcessRunner => ({
    run: async (request) => {
      const [command = ""] = "argv" in request.command ? request.command.argv : [];
      if (command !== "git" || output === undefined) return { kind: "not-started", reason: "spawn-error", message: "not found", code: "ENOENT" };
      if (request.stdout?.file !== undefined) writeFileSync(request.stdout.file, `${output}\n`);
      return { kind: "finished", pid: 1, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0 };
    },
  });

  it("reports the version of a git that is new enough", async () => {
    const health = await machineChecks(runnerWithGit("git version 2.47.1"))();
    expect(health.git).toEqual({ ok: true, version: "git version 2.47.1" });
  });

  it("reports the version of a git that is too old, with the reason", async () => {
    const health = await machineChecks(runnerWithGit("git version 2.37.1"))();
    expect(health.git).toEqual({ ok: false, version: "git version 2.37.1", message: "git 2.38 or newer is required; found: git version 2.37.1" });
  });

  it("reports no version when git is missing", async () => {
    const health = await machineChecks(runnerWithGit(undefined))();
    expect(health.git.ok).toBe(false);
    expect(health.git).not.toHaveProperty("version");
  });
});
