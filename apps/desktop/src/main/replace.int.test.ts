// The replace against real processes: a fake older engine, `ps`, real signals and the client's
// shutdown request. The engine's own tests cover this version's engine accepting the request.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestShutdown } from "@tokama/client";
import { API_VERSION, posixEngineProcesses } from "@tokama/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineCommandEnd } from "./engine.js";
import { replaceOlderEngine, type ReplaceOptions } from "./replace.js";
import { alive, oldEngineNotes, startOldEngine } from "./testing/old-engine.js";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

function tempDir(): string {
  // Real path: on macOS the temp dir is a symlink, and ps shows the path as it was passed.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tk-rep-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function killAtEnd(pid: number): void {
  cleanups.push(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
}

function options(dir: string, overrides: Partial<ReplaceOptions> = {}): ReplaceOptions {
  return {
    dir,
    engine: { lockPath: join(dir, "engine.lock"), commandEnd: engineCommandEnd(dir) },
    processes: posixEngineProcesses,
    requestShutdown: (engineDir) => requestShutdown(engineDir),
    stepMs: 3_000,
    pollMs: 50,
    ...overrides,
  };
}

async function oldEngine(root: string, dir: string, extra: { ignoreTerm?: boolean; sample?: boolean } = {}): Promise<number> {
  const pid = await startOldEngine({ root, dir, apiVersion: API_VERSION - 1, ...extra });
  killAtEnd(pid);
  return pid;
}

describe("replaceOlderEngine", () => {
  it("stops an older engine that does not know the shutdown request with SIGTERM", async () => {
    const root = tempDir();
    const dir = join(root, "run");
    const pid = await oldEngine(root, dir);
    expect(await replaceOlderEngine(options(dir))).toEqual({ ok: true, forced: false });
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(oldEngineNotes(dir)).toEqual(["ready", "got shutdown", "SIGTERM"]);
  });

  it("uses SIGKILL for a verified engine that ignores SIGTERM, and says it was forced", async () => {
    const root = tempDir();
    const dir = join(root, "run");
    const pid = await oldEngine(root, dir, { ignoreTerm: true });
    expect(await replaceOlderEngine(options(dir, { stepMs: 500 }))).toEqual({ ok: true, forced: true });
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it.each([
    ["a process that is no engine", "sleep"],
    ["the sample engine, for the real engine's dir", "sample"],
    ["an engine for another dir", "other"],
    ["a pid that started after the lock was written", "reused"],
  ])("never signals %s", async (_name, kind) => {
    const root = tempDir();
    const dir = join(root, "run");
    let pid: number;
    if (kind === "sleep") {
      const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore", detached: true });
      sleeper.unref();
      pid = sleeper.pid ?? 0;
      killAtEnd(pid);
      // A stale lock whose pid now belongs to another process.
      await oldEngine(root, dir);
      writeFileSync(join(dir, "engine.lock"), `${pid} old-1\n`);
    } else if (kind === "sample") {
      pid = await oldEngine(root, join(dir, "sample"), { sample: true });
      // The sample engine's pid in the real engine dir's lock.
      await oldEngine(join(root, "b"), dir);
      writeFileSync(join(dir, "engine.lock"), `${pid} old-1\n`);
    } else if (kind === "other") {
      pid = await oldEngine(root, join(root, "other"));
      await oldEngine(join(root, "b"), dir);
      writeFileSync(join(dir, "engine.lock"), `${pid} old-1\n`);
    } else {
      pid = await oldEngine(root, dir);
      // The lock is dated an hour before the process started: its pid was taken by a new process.
      const past = (Date.now() - 3_600_000) / 1000;
      utimesSync(join(dir, "engine.lock"), past, past);
    }
    const result = await replaceOlderEngine(options(dir));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("could not confirm") });
    expect(alive(pid)).toBe(true);
    if (kind === "reused") expect(oldEngineNotes(dir)).toEqual(["ready"]);
  });

  it("takes over a replace.lock whose app is no longer running", async () => {
    const root = tempDir();
    const dir = join(root, "run");
    const pid = await oldEngine(root, dir);
    const done = spawn("/usr/bin/true");
    await new Promise((resolve) => done.once("exit", resolve));
    writeFileSync(join(dir, "replace.lock"), `${done.pid ?? 0} ${Date.now()}\n`);
    expect(await replaceOlderEngine(options(dir))).toEqual({ ok: true, forced: false });
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("stops waiting for another app once it is done, even when the old engine still runs", async () => {
    const root = tempDir();
    const dir = join(root, "run");
    const pid = await oldEngine(root, dir);
    // Another running app (this test process) holds replace.lock, then lets go without stopping the engine.
    writeFileSync(join(dir, "replace.lock"), `${process.pid} ${Date.now()}\n`);
    setTimeout(() => rmSync(join(dir, "replace.lock")), 200);
    expect(await replaceOlderEngine(options(dir))).toEqual({ ok: true, forced: false });
    expect(alive(pid)).toBe(true);
    expect(oldEngineNotes(dir)).toEqual(["ready"]);
  });

  it("with two apps at once, only one sends anything; the other waits for the old engine to go", async () => {
    const root = tempDir();
    const dir = join(root, "run");
    const pid = await oldEngine(root, dir);
    const [first, second] = await Promise.all([replaceOlderEngine(options(dir)), replaceOlderEngine(options(dir))]);
    expect(first).toEqual({ ok: true, forced: false });
    expect(second).toEqual({ ok: true, forced: false });
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(oldEngineNotes(dir).filter((note) => note === "got shutdown" || note === "SIGTERM")).toEqual(["got shutdown", "SIGTERM"]);
  });
});
