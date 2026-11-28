// The engine as a real background process, started on demand by the client. Runs the built
// entry (dist/main.js): Node cannot run the TypeScript sources directly, because they import
// `./x.js`. `pnpm build` runs before `pnpm test` in CI.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { readEngineLock, tokenPathOf } from "@tokama/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tempEngineDir, waitFor } from "./testing/helpers.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let cleanups: (() => unknown)[] = [];

/** Tokama's home folder for a test engine: next to its engine dir, never the real `~/.tokama`. */
const homeOf = (dir: string) => join(dirname(dir), "home");
/** A real engine's lock is in its home folder. */
const lockOf = (dir: string) => join(homeOf(dir), "engine.lock");

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

beforeAll(() => {
  if (!existsSync(MAIN)) throw new Error(`${MAIN} is missing: run \`pnpm build\` first`);
});

const lockPid = (dir: string): number | undefined => {
  try {
    return Number.parseInt(readFileSync(lockOf(dir), "utf8"), 10);
  } catch {
    return undefined;
  }
};

/** Kills whatever engine owns `dir` when the test ends, even if the test failed. */
function killEngineAfter(dir: string): void {
  cleanups.push(async () => {
    const pid = lockPid(dir);
    if (pid === undefined) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
}

const command = (dir: string, ...extra: string[]) => ({ command: process.execPath, args: [MAIN, "--dir", dir, "--home", homeOf(dir), ...extra] });

async function connectStarting(dir: string): Promise<EngineClient> {
  const connected = await connect({ dir, lockPath: lockOf(dir), start: command(dir), startTimeoutMs: 15_000 });
  if (!connected.ok) throw new Error(`${connected.error.code}: ${connected.error.message}`);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

describe("engine process", () => {
  it("is started on demand, stops on SIGTERM, and the client reconnects to a restarted engine", { timeout: 40_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const engineClient = await connectStarting(dir);
    const events: ClientEvent[] = [];
    void (async () => {
      for await (const event of engineClient.events()) events.push(event);
    })();

    expect(await engineClient.query({ type: "board" })).toEqual({ ok: true, data: { items: [], counts: [] } });
    expect(await engineClient.query({ type: "diagnostics_settings" })).toMatchObject({ ok: true, data: { crashWaiting: false } });
    // Item storage is open in the home folder.
    for (const file of ["host.json", "items", "tokama.db"]) expect(existsSync(join(homeOf(dir), file))).toBe(true);
    const firstPid = lockPid(dir);
    const firstEngine = engineClient.engineId;
    expect(firstPid).toBeGreaterThan(0);

    // SIGTERM: graceful shutdown. The client then starts a new engine and reconnects.
    process.kill(firstPid ?? 0, "SIGTERM");
    await waitFor(() => events.some((event) => event.kind === "disconnected"), 15_000, "disconnected");
    await waitFor(() => events.some((event) => event.kind === "reconnected"), 20_000, "reconnected");

    expect(engineClient.engineId).not.toBe(firstEngine);
    expect(lockPid(dir)).not.toBe(firstPid);
    expect(await engineClient.query({ type: "board" })).toEqual({ ok: true, data: { items: [], counts: [] } });
  });

  it("records a crash after it was killed, and flags it on the next start: the next engine takes over the dead engine's lock", { timeout: 40_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const first = await connect({ dir, lockPath: lockOf(dir), start: command(dir), startTimeoutMs: 15_000, reconnect: false });
    if (!first.ok) throw new Error(first.error.message);
    expect(await first.value.query({ type: "diagnostics_settings" })).toMatchObject({ ok: true, data: { collect: true, crashWaiting: false } });
    const dead = readEngineLock(lockOf(dir));
    const stopStartedAt = Date.now();
    process.kill(lockPid(dir) ?? 0, "SIGKILL");
    await first.value.close();
    // Killed: its lock and socket file stay behind.
    expect(readEngineLock(lockOf(dir))?.engineId).toBe(dead?.engineId);

    const second = await connectStarting(dir);
    expect(readEngineLock(lockOf(dir))?.engineId).not.toBe(dead?.engineId);
    // The new engine sweeps the dead one's socket once it is up; a client may connect before that.
    await waitFor(() => !existsSync(dead?.socketPath ?? ""), 10_000, "the dead engine's socket swept");
    const crashes = await second.query({ type: "diagnostics_list", types: ["crash"] });
    expect(crashes).toMatchObject({ ok: true, data: { entries: [{ type: "crash", source: "engine", kind: "unclean_exit", engineVersion: "0.0.0" }] } });
    const setup = await second.query({ type: "setup" });
    expect(setup.ok && setup.data.health.crashWaiting).toBe(true);

    // What the app does after it killed an engine itself: lists the new entry by time and deletes it.
    const listed = await second.query({ type: "diagnostics_list", types: ["crash"], since: stopStartedAt });
    // The time filter works: nothing is listed from after now.
    expect(await second.query({ type: "diagnostics_list", types: ["crash"], since: Date.now() + 60_000 })).toMatchObject({ ok: true, data: { entries: [] } });
    const ids = listed.ok ? listed.data.entries.map((entry) => entry.id) : [];
    expect(ids).toHaveLength(1);
    expect(await second.command({ type: "diagnostics_delete", ids })).toEqual({ ok: true, data: { deleted: 1 } });
    expect(await second.query({ type: "diagnostics_list", types: ["crash"] })).toMatchObject({ ok: true, data: { entries: [] } });
    const after = await second.query({ type: "setup" });
    expect(after.ok && after.data.health.crashWaiting).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("counts a stop by %s as clean: the next start has no crash flag and no crash entry", { timeout: 40_000 }, async (signal) => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const first = await connect({ dir, lockPath: lockOf(dir), start: command(dir), startTimeoutMs: 15_000, reconnect: false });
    if (!first.ok) throw new Error(first.error.message);
    const pid = lockPid(dir) ?? 0;
    process.kill(pid, signal);
    await waitFor(() => !existsSync(lockOf(dir)), 15_000, "engine stopped");
    await first.value.close();

    const second = await connectStarting(dir);
    expect(await second.query({ type: "diagnostics_list", types: ["crash"] })).toMatchObject({ ok: true, data: { entries: [] } });
    const setup = await second.query({ type: "setup" });
    expect(setup.ok && setup.data.health.crashWaiting).toBe(false);
  });

  it("removes its files on SIGTERM", { timeout: 30_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const connected = await connect({ dir, lockPath: lockOf(dir), start: command(dir), startTimeoutMs: 15_000, reconnect: false });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    const lock = readEngineLock(lockOf(dir));
    if (lock === undefined) throw new Error("no lock");

    process.kill(lock.pid, "SIGTERM");
    const files = [lock.socketPath, tokenPathOf(lock.socketPath), lockOf(dir)];
    await waitFor(() => files.every((file) => !existsSync(file)), 15_000, "engine files removed");
  });

  it("exits with code 3 when an engine already runs on the home, and leaves its files alone", { timeout: 30_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    await connectStarting(dir);
    const lock = readEngineLock(lockOf(dir));
    if (lock === undefined) throw new Error("no lock");
    const token = readFileSync(tokenPathOf(lock.socketPath), "utf8");

    const second = spawnSync(process.execPath, command(dir).args, { encoding: "utf8", timeout: 15_000 });
    expect(second.status).toBe(3);
    expect(second.stderr).toContain("already running");
    expect(readFileSync(tokenPathOf(lock.socketPath), "utf8")).toBe(token);
    expect(readEngineLock(lockOf(dir))?.text).toBe(lock.text);
  });

  it("lets only one of two engine processes that start at once on a stale lock run", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 5; round++) {
      const dir = tempEngineDir(cleanups);
      killEngineAfter(dir);
      // A crashed engine's lock names a socket nobody listens on.
      mkdirSync(homeOf(dir), { recursive: true, mode: 0o700 });
      writeFileSync(lockOf(dir), `${process.pid} e-crashed ${join(dir, "s-deadbeef.sock")}\n`, { mode: 0o600 });
      const exited: boolean[] = [];
      const run = () =>
        new Promise<{ code: number | null; child: ChildProcess }>((resolve) => {
          const index = exited.push(false) - 1;
          const child = spawn(process.execPath, command(dir).args, { stdio: "ignore" });
          cleanups.push(() => child.kill("SIGKILL"));
          child.once("exit", (code) => {
            exited[index] = true;
            resolve({ code, child });
          });
        });
      const runs = [run(), run()];
      // Settled: at least one has exited with 3 (an engine that yields exits at once).
      const early = await Promise.race([...runs, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000))]);
      expect(early?.code, `round ${round}`).toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // Never two engines at once. (Two starters that cross each other may both yield; the next start takes the lock.)
      const running = runs.length - runs.filter((_, index) => exited[index]).length;
      expect(running, `round ${round}`).toBeLessThanOrEqual(1);
      const lock = readEngineLock(lockOf(dir));
      if (running === 1 && lock !== undefined) process.kill(lock.pid, "SIGTERM");
      const done = await Promise.all(runs);
      expect(done.every((result) => result.code === 3 || result.code === 0), `round ${round}`).toBe(true);
    }
  });

  it("serves the sample data set with --sample", { timeout: 30_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    // The sample engine keeps its lock in its own dir; the home is not touched.
    const connected = await connect({ dir, lockPath: join(dir, "engine.lock"), start: command(dir, "--sample"), startTimeoutMs: 15_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    expect(existsSync(lockOf(dir))).toBe(false);

    const setup = await connected.value.query({ type: "setup" });
    expect(setup.ok && setup.data.repos.map((repo) => repo.id)).toEqual(["orders-api", "checkout-web", "inventory-service"]);
    const board = await connected.value.query({ type: "board" });
    expect(board.ok && board.data.items.length).toBeGreaterThan(0);
    cleanups.push(() => {
      try {
        process.kill(Number.parseInt(readFileSync(join(dir, "engine.lock"), "utf8"), 10), "SIGKILL");
      } catch {
        // Already gone.
      }
    });
  });

  it("reports start_failed when the engine command cannot run", async () => {
    const dir = tempEngineDir(cleanups);
    const connected = await connect({ dir, lockPath: lockOf(dir), start: { command: `${dir}/no-such-engine`, args: [] }, startTimeoutMs: 5_000 });
    expect(connected).toMatchObject({ ok: false, error: { code: "start_failed" } });
  });
});
