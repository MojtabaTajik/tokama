import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION, encodeLine, type Liveness, type ManualClock, manualClock, SHUTDOWN_IF_IDLE_SINCE } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopEngine, type StopOptions } from "./stop.js";

const PID = 4821;
const ID = "e-1";

let root: string;
let dir: string;
let cleanups: (() => unknown)[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tk-stop-"));
  dir = join(root, "run");
  mkdirSync(dir, { mode: 0o700 });
  cleanups = [];
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(root, { recursive: true, force: true });
});

const socketPath = () => join(dir, "s-1a2b3c4d.sock");
const lockPath = () => join(dir, "engine.lock");
const writeLock = (pid: number, id: string) => writeFileSync(lockPath(), `${pid} ${id} ${socketPath()}\n`);

interface FakeEngine {
  /** Every message the engine received, parsed. */
  readonly received: Record<string, unknown>[];
  /** Number of connections accepted, probes included. */
  readonly connections: () => number;
  /** Stops listening and removes its lock, as an engine that exits does. */
  stop(): Promise<void>;
}

/** A plain socket server that stands in for an engine. `answer` gets each message and its socket. */
async function fakeEngine(answer: (message: Record<string, unknown>, socket: Socket, engine: FakeEngine) => void = () => {}): Promise<FakeEngine> {
  writeFileSync(join(dir, "s-1a2b3c4d.token"), "tok\n");
  const received: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server: Server = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        answer(message, socket, engine);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath(), resolve));
  let stopped: Promise<void> | undefined;
  const engine: FakeEngine = {
    received,
    connections: () => accepted,
    stop: () => {
      stopped ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        try {
          unlinkSync(lockPath());
        } catch {
          // Already gone.
        }
      });
      return stopped;
    },
  };
  cleanups.push(() => engine.stop());
  return engine;
}

const send = (socket: Socket, message: Record<string, unknown>) => {
  const line = encodeLine(message);
  if (line.ok) socket.write(line.value);
};
/** An engine of an earlier build: it accepts without saying who it is. */
const accept = (socket: Socket) => send(socket, { kind: "shutdown_accepted", apiVersion: API_VERSION });
/** An engine of this build: it says its id and pid. */
const acceptAs = (socket: Socket, engineId: string, pid: number) => send(socket, { kind: "shutdown_accepted", apiVersion: API_VERSION, engineId, pid });
/** What an engine from before the shutdown request answers. */
const bad = (socket: Socket) => send(socket, { kind: "connection_error", apiVersion: 1, code: "bad_message", message: "the first message must be a hello" });

/** Lets real socket I/O run while the manual clock moves, so waits end without real sleeping. */
async function run<T>(clock: ManualClock, work: Promise<T>): Promise<T> {
  let done = false;
  const finished = work.finally(() => (done = true));
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(50);
  }
  return finished;
}

function setup(options: Partial<StopOptions> = {}) {
  const clock = manualClock();
  const signals: [number, string][] = [];
  const stop = (override: Partial<StopOptions> = {}) =>
    run(clock, stopEngine({ lockPath: lockPath(), ifIdle: true, force: true, signal: (pid, signal) => void signals.push([pid, signal]), clock, ...options, ...override }));
  return { stop, signals, clock };
}

describe("stopEngine", () => {
  it("stops an idle engine of this API with one request, and signals nothing", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket, self) => {
      accept(socket);
      void self.stop();
    });
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID, engine: { apiVersion: API_VERSION, runningItems: 0 } })).toEqual({ kind: "stopped", forced: false });
    expect(engine.received).toEqual([{ kind: "shutdown", apiVersion: API_VERSION, token: "tok", ifIdle: true }]);
    expect(signals).toEqual([]);
  });

  it("is refused when the engine says items run, and sends no signal even when it may force", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => send(socket, { kind: "shutdown_refused", apiVersion: API_VERSION, runningItems: 2 }));
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "refused", runningItems: 2 });
    expect(signals).toEqual([]);
  });

  it("is refused without a count when the engine could not count", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => send(socket, { kind: "shutdown_refused", apiVersion: API_VERSION }));
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "refused" });
    expect(signals).toEqual([]);
  });

  it("sends nothing to an engine from before ifIdle that runs 3 items, or that did not say", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => accept(socket));
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID, engine: { apiVersion: SHUTDOWN_IF_IDLE_SINCE - 1, runningItems: 3 } })).toEqual({ kind: "refused", runningItems: 3 });
    expect(await stop({ expectedEngineId: ID, engine: { apiVersion: 1 } })).toEqual({ kind: "refused" });
    expect(engine.received).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("sends a plain shutdown, without ifIdle, to an engine from before ifIdle that runs nothing", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket, self) => {
      accept(socket);
      void self.stop();
    });
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID, engine: { apiVersion: SHUTDOWN_IF_IDLE_SINCE - 1, runningItems: 0 } })).toEqual({ kind: "stopped", forced: false });
    expect(engine.received).toEqual([{ kind: "shutdown", apiVersion: API_VERSION, token: "tok" }]);
    expect(signals).toEqual([]);
  });

  it("asks a stop that is not ifIdle without any count, and stops a busy engine", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket, self) => {
      accept(socket);
      void self.stop();
    });
    const { stop } = setup();
    expect(await stop({ ifIdle: false, expectedEngineId: ID, engine: { apiVersion: 1, runningItems: 4 } })).toEqual({ kind: "stopped", forced: false });
    expect(engine.received).toEqual([{ kind: "shutdown", apiVersion: API_VERSION, token: "tok" }]);
  });

  it("escalates to SIGTERM, then SIGKILL, for an engine that refuses the request; SIGKILL makes it forced", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup({
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        // The engine ignores SIGTERM and dies of SIGKILL, leaving its lock behind.
        if (signal === "SIGKILL") void engine.stop();
      },
    });
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "stopped", forced: true });
    expect(signals).toEqual([
      [PID, "SIGTERM"],
      [PID, "SIGKILL"],
    ]);
  });

  it("stops with SIGTERM alone when the engine ends cleanly on it", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup({
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        void engine.stop();
      },
    });
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([[PID, "SIGTERM"]]);
  });

  it("signals an engine that accepted the request but does not end, when it may force", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => accept(socket));
    const { stop, signals } = setup({
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        void engine.stop();
      },
    });
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([[PID, "SIGTERM"]]);
  });

  it("reports an engine that survives both signals, with its pid", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup();
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "still_running", pid: PID });
    expect(signals.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("signals nothing when it may not force", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup();
    expect(await stop({ ifIdle: false, force: false, expectedEngineId: ID })).toEqual({ kind: "still_running", pid: PID });
    expect(signals).toEqual([]);
  });

  it("does not signal an engine it could not show to be idle", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup();
    // Silent, and its last count is unknown or above zero.
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "still_running", pid: PID });
    expect(await stop({ expectedEngineId: ID, engine: { apiVersion: API_VERSION, runningItems: 1 } })).toEqual({ kind: "still_running", pid: PID });
    expect(signals).toEqual([]);
  });

  it("signals a silent engine that was idle when it was last counted, for a stop that is ifIdle", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup({
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        void engine.stop();
      },
    });
    expect(await stop({ expectedEngineId: ID, engine: { apiVersion: SHUTDOWN_IF_IDLE_SINCE - 1, runningItems: 0 } })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([[PID, "SIGTERM"]]);
  });

  it("does not trust an old count of an engine that knows ifIdle and stays silent", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID, engine: { apiVersion: API_VERSION, runningItems: 0 } })).toEqual({ kind: "still_running", pid: PID });
    expect(signals).toEqual([]);
  });

  it("never signals a newer engine that took the dir meanwhile, even when no engine id was given", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => accept(socket));
    let probes = 0;
    // The old engine accepted but stays; a lock for another engine appears before the signal.
    const probe = async (): Promise<Liveness> => {
      if (++probes === 3) writeLock(5000, "e-2");
      return "alive";
    };
    const { stop, signals } = setup({ probe, stepMs: 100 });
    expect(await stop({})).toEqual({ kind: "replaced" });
    expect(signals).toEqual([]);
  });

  it("signals nothing when nothing listens, even though the lock names this test's own pid", async () => {
    writeLock(process.pid, ID);
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([]);
  });

  it("is stopped when there is no lock and nothing listens", async () => {
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([]);
  });

  it("sends nothing when the lock names another engine than the one meant", async () => {
    writeLock(PID, "e-2");
    const engine = await fakeEngine((_message, socket) => accept(socket));
    const { stop, signals } = setup();
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "replaced" });
    expect(engine.received).toEqual([]);
    expect(engine.connections()).toBe(0);
    expect(signals).toEqual([]);
  });

  it("sends no signal when the lock is rewritten to another engine just before it", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => bad(socket));
    let probes = 0;
    // The entry check and the check before the signal each probe once; the lock changes in between.
    const probe = async (): Promise<Liveness> => {
      if (++probes === 2) writeLock(5000, "e-2");
      return "alive";
    };
    const { stop, signals } = setup({ probe });
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "replaced" });
    expect(signals).toEqual([]);
  });

  it("sends no signal when it cannot tell whether the socket answers", async () => {
    writeLock(PID, ID);
    await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup({ probe: async () => "unknown" });
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "still_running", pid: PID });
    expect(signals).toEqual([]);
  });

  it("never signals its own process", async () => {
    writeLock(process.pid, ID);
    await fakeEngine((_message, socket) => bad(socket));
    const { stop, signals } = setup();
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "still_running", pid: process.pid });
    expect(signals).toEqual([]);
  });

  it("never sends the token into a folder that is not private, and signals nothing there", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => accept(socket));
    chmodSync(dir, 0o755);
    const { stop, signals } = setup();
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "still_running", pid: PID });
    expect(engine.received).toEqual([]);
    expect(signals).toEqual([]);
    expect(existsSync(socketPath())).toBe(true);
  });

  it("stops an engine of this build with its identity proven at each signal, and re-asks before each one", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => acceptAs(socket, ID, PID));
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "still_running", pid: PID });
    expect(signals).toEqual([
      [PID, "SIGTERM"],
      [PID, "SIGKILL"],
    ]);
    // The request, then one identity check before each signal.
    expect(engine.received).toHaveLength(3);
    expect(engine.received.every((message) => message["kind"] === "shutdown" && message["token"] === "tok")).toBe(true);
  });

  it("signals nothing when the socket answers with another pid or another engine id than the lock names", async () => {
    writeLock(PID, ID);
    const { stop, signals } = setup();
    for (const [engineId, pid] of [[ID, PID + 1], ["e-other", PID]] as const) {
      const engine = await fakeEngine((_message, socket) => acceptAs(socket, engineId, pid));
      expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "replaced" });
      expect(signals).toEqual([]);
      await engine.stop();
      writeLock(PID, ID);
    }
  });

  it("signals nothing when the lock changes between the engine's reply and the signal", async () => {
    writeLock(PID, ID);
    let requests = 0;
    await fakeEngine((_message, socket) => {
      // The first request is the stop; the second is the identity check before the signal.
      if (++requests === 2) writeLock(5000, "e-2");
      acceptAs(socket, ID, PID);
    });
    const { stop, signals } = setup();
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "replaced" });
    expect(signals).toEqual([]);
  });

  it("signals an engine that gives no identity (an older build) only while its socket accepts and the lock is unchanged", async () => {
    writeLock(PID, ID);
    const engine = await fakeEngine((_message, socket) => accept(socket));
    const { stop, signals } = setup({
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        void engine.stop();
      },
    });
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([[PID, "SIGTERM"]]);
  });

  it("signals nothing when the lock names a live process that is not an engine and its socket is dead", async () => {
    // A stale lock after a crash whose pid another process took over: this test's parent stands in.
    writeLock(process.ppid, ID);
    const { stop, signals } = setup();
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(await stop({ ifIdle: false })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([]);
  });

  it("signals nothing when the socket dies between the request and the signal, though the lock names a live process", async () => {
    writeLock(process.ppid, ID);
    const engine = await fakeEngine((_message, socket) => bad(socket));
    let probes = 0;
    // Alive at the entry; dead right before the signal.
    const probe = async (): Promise<Liveness> => {
      if (++probes === 2) await engine.stop();
      return probes === 1 ? "alive" : "dead";
    };
    const { stop, signals } = setup({ probe });
    expect(await stop({ ifIdle: false, expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([]);
  });

  it("waits for the lock to go as well, and ends at the deadline when only the lock remains", async () => {
    writeLock(PID, ID);
    // The engine accepts and closes its socket, but its lock stays (a kill or a crash).
    await fakeEngine((_message, socket, self) => {
      accept(socket);
      void self.stop().then(() => writeLock(PID, ID));
    });
    const { stop, signals, clock } = setup({ stepMs: 1_000 });
    const before = clock.now();
    expect(await stop({ expectedEngineId: ID })).toEqual({ kind: "stopped", forced: false });
    expect(clock.now() - before).toBeGreaterThanOrEqual(1_000);
    expect(signals).toEqual([]);
  });
});
