// The engine as a real background process, started on demand by the client. Runs the built
// entry (dist/main.js): Node cannot run the TypeScript sources directly, because they import
// `./x.js`. `pnpm build` runs before `pnpm test` in CI.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir, waitFor } from "./testing/helpers.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let cleanups: (() => unknown)[] = [];

/** Tokama's home folder for a test engine: next to its engine dir, never the real `~/.tokama`. */
const homeOf = (dir: string) => join(dirname(dir), "home");

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

beforeAll(() => {
  if (!existsSync(MAIN)) throw new Error(`${MAIN} is missing: run \`pnpm build\` first`);
});

const lockPid = (dir: string): number | undefined => {
  try {
    return Number.parseInt(readFileSync(`${dir}/engine.lock`, "utf8"), 10);
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

async function connectStarting(dir: string): Promise<EngineClient> {
  const connected = await connect({ dir, start: { command: process.execPath, args: [MAIN, "--dir", dir, "--home", homeOf(dir)] }, startTimeoutMs: 15_000 });
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

  it("records a crash after it was killed, and flags it on the next start", { timeout: 40_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const first = await connect({ dir, start: { command: process.execPath, args: [MAIN, "--dir", dir, "--home", homeOf(dir)] }, startTimeoutMs: 15_000, reconnect: false });
    if (!first.ok) throw new Error(first.error.message);
    expect(await first.value.query({ type: "diagnostics_settings" })).toMatchObject({ ok: true, data: { collect: true, crashWaiting: false } });
    process.kill(lockPid(dir) ?? 0, "SIGKILL");
    await first.value.close();

    const second = await connectStarting(dir);
    const crashes = await second.query({ type: "diagnostics_list", types: ["crash"] });
    expect(crashes).toMatchObject({ ok: true, data: { entries: [{ type: "crash", source: "engine", kind: "unclean_exit", engineVersion: "0.0.0" }] } });
    const setup = await second.query({ type: "setup" });
    expect(setup.ok && setup.data.health.crashWaiting).toBe(true);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("counts a stop by %s as clean: the next start has no crash flag and no crash entry", { timeout: 40_000 }, async (signal) => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const first = await connect({ dir, start: { command: process.execPath, args: [MAIN, "--dir", dir, "--home", homeOf(dir)] }, startTimeoutMs: 15_000, reconnect: false });
    if (!first.ok) throw new Error(first.error.message);
    const pid = lockPid(dir) ?? 0;
    process.kill(pid, signal);
    await waitFor(() => !existsSync(`${dir}/engine.lock`), 15_000, "engine stopped");
    await first.value.close();

    const second = await connectStarting(dir);
    expect(await second.query({ type: "diagnostics_list", types: ["crash"] })).toMatchObject({ ok: true, data: { entries: [] } });
    const setup = await second.query({ type: "setup" });
    expect(setup.ok && setup.data.health.crashWaiting).toBe(false);
  });

  it("removes its files on SIGTERM", { timeout: 30_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const connected = await connect({ dir, start: { command: process.execPath, args: [MAIN, "--dir", dir, "--home", homeOf(dir)] }, startTimeoutMs: 15_000, reconnect: false });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());

    process.kill(lockPid(dir) ?? 0, "SIGTERM");
    const files = ["engine.sock", "engine.token", "engine.lock"].map((name) => `${dir}/${name}`);
    await waitFor(() => files.every((file) => !existsSync(file)), 15_000, "engine files removed");
  });

  it("exits with code 3 when an engine already runs in the dir", { timeout: 30_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    await connectStarting(dir);
    const token = readFileSync(`${dir}/engine.token`, "utf8");

    const second = spawnSync(process.execPath, [MAIN, "--dir", dir, "--home", homeOf(dir)], { encoding: "utf8", timeout: 15_000 });
    expect(second.status).toBe(3);
    expect(second.stderr).toContain("already running");
    expect(readFileSync(`${dir}/engine.token`, "utf8")).toBe(token);
  });

  it("does not take the locks of an engine that has been starting for longer than 10 s", { timeout: 60_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    const home = homeOf(dir);
    const otherDir = join(dirname(dir), "other");
    // The second engines run a minute ahead of this one, as if they started a minute later.
    const later = ["--import", "data:text/javascript,const now = Date.now; Date.now = () => now() + 60000;"];
    const second: { status: number | null; stderr: string }[] = [];
    // This engine holds both locks and has not opened its storage or listened yet. The second
    // engines start and end while it waits here.
    const onDiagnostics = () => {
      for (const engineDir of [dir, otherDir]) {
        const run = spawnSync(process.execPath, [...later, MAIN, "--dir", engineDir, "--home", home], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
        second.push({ status: run.status, stderr: run.stderr });
      }
    };
    const first = await startEngine({ dir, home, onDiagnostics });
    if (!first.ok) throw new Error(first.error.message);
    cleanups.push(() => first.value.close());

    expect(second.map((run) => run.status)).toEqual([3, 3]);
    expect(second.every((run) => run.stderr.includes("already running"))).toBe(true);
    expect(readFileSync(join(dir, "engine.lock"), "utf8")).toBe(`${process.pid} ${first.value.engineId}\n`);
    expect(readFileSync(join(home, "engine.lock"), "utf8")).toContain(first.value.engineId);
    expect(existsSync(join(otherDir, "engine.lock"))).toBe(false);
  });

  it("serves the sample data set with --sample", { timeout: 30_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    killEngineAfter(dir);
    const connected = await connect({ dir, start: { command: process.execPath, args: [MAIN, "--dir", dir, "--home", homeOf(dir), "--sample"] }, startTimeoutMs: 15_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());

    const setup = await connected.value.query({ type: "setup" });
    expect(setup.ok && setup.data.repos.map((repo) => repo.id)).toEqual(["orders-api", "checkout-web", "inventory-service"]);
    const board = await connected.value.query({ type: "board" });
    expect(board.ok && board.data.items.length).toBeGreaterThan(0);
  });

  it("reports start_failed when the engine command cannot run", async () => {
    const dir = tempEngineDir(cleanups);
    const connected = await connect({ dir, start: { command: `${dir}/no-such-engine`, args: [] }, startTimeoutMs: 5_000 });
    expect(connected).toMatchObject({ ok: false, error: { code: "start_failed" } });
  });
});
