// Client behavior against fake engines. The full client-engine tests live in apps/engine.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION, parseClientMessage, probeSocket, tokenPathOf, type CommandMessageInput, type QueryMessageInput } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { connect, requestShutdown, stopEngine, type ConnectOptions } from "./index.js";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tk-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Fake {
  readonly dir: string;
  readonly lockPath: string;
  readonly socketPath: string;
  /** Connections accepted so far. */
  readonly accepted: () => number;
  /** Ends the connections and stops listening, as an engine that dies does; its lock stays. */
  readonly close: () => Promise<void>;
}

/**
 * A plain socket server that stands in for an engine: it listens on a socket in a private dir, with
 * the token next to it, and (unless `lock` is false) a lock that names it.
 */
async function fakeEngine(onConnection: (socket: Socket) => void, options: { dir?: string; name?: string; lock?: boolean; mode?: number } = {}): Promise<Fake> {
  const dir = options.dir ?? tempDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = join(dir, options.name ?? "s-1a2b3c4d.sock");
  const lockPath = join(dir, "engine.lock");
  writeFileSync(tokenPathOf(socketPath), "t0k");
  if (options.lock !== false) writeFileSync(lockPath, `${process.pid} e1 ${socketPath}\n`, { mode: options.mode ?? 0o600 });
  if (options.mode !== undefined) chmodSync(lockPath, options.mode);
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server: Server = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
    return closed;
  };
  cleanups.push(close);
  return { dir, lockPath, socketPath, accepted: () => accepted, close };
}

/** A fake engine that answers the first line of every connection with `answer`, then closes it. */
const answering = (answer: string) => (socket: Socket) => socket.once("data", () => socket.end(answer));
const welcome = (engineId = "e1", extra: object = {}) => `${JSON.stringify({ kind: "welcome", apiVersion: API_VERSION, engineId, ...extra })}\n`;
const open = (fake: Pick<Fake, "dir" | "lockPath">, extra: Partial<ConnectOptions> = {}) => connect({ dir: fake.dir, lockPath: fake.lockPath, ...extra });

describe("@tokama/client", () => {
  // Typed against core's built .d.ts: outbound messages take ids as plain strings, no casts.
  it("builds outbound messages from plain string ids", () => {
    const itemId: string = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
    const decisionId: string = "decision_2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
    const query: QueryMessageInput = { apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "item", itemId } };
    const command: CommandMessageInput = {
      apiVersion: API_VERSION,
      kind: "command",
      requestId: "r2",
      command: { type: "resolve_decision", itemId, decisionId, choice: "approve" },
    };
    expect(parseClientMessage(query)).toEqual({ ok: true, value: query });
    expect(parseClientMessage(command)).toEqual({ ok: true, value: command });
  });

  it("parses command reply data per command type, and reports invalid_reply for the wrong shape", async () => {
    const itemId = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
    // Answers the hello, then each command: start_item with a good id, stop_item with data it must not have.
    const fake = await fakeEngine((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const message = JSON.parse(line) as { kind: string; requestId?: string; command?: { type: string } };
          if (message.kind === "hello") {
            socket.write(welcome());
            continue;
          }
          const data = { itemId };
          socket.write(`${JSON.stringify({ apiVersion: API_VERSION, kind: "reply", requestId: message.requestId, result: { ok: true, data } })}\n`);
        }
      });
    });
    const connected = await open(fake, { reconnect: false });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());

    const started = await connected.value.command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: [], text: "x" });
    // Typed per command: no cast needed to read itemId.
    expect(started.ok && started.data.itemId).toBe(itemId);
    expect(await connected.value.command({ type: "stop_item", itemId })).toMatchObject({ ok: false, error: { code: "invalid_reply" } });
  });

  it("skips an event type a newer engine added, and keeps the connection", async () => {
    const event = (seq: number, body: object) => `${JSON.stringify({ apiVersion: API_VERSION, kind: "event", seq, event: body })}\n`;
    const fake = await fakeEngine((socket) => {
      socket.on("data", (chunk) => {
        if (!chunk.toString().includes('"hello"')) return;
        socket.write(welcome());
        // After the client starts listening.
        setTimeout(() => {
          socket.write(event(0, { type: "weather_changed", sky: "clear" }));
          socket.write(event(1, { type: "usage_changed" }));
        }, 200);
      });
    });
    const connected = await open(fake, { reconnect: false });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    const seen: string[] = [];
    for await (const received of connected.value.events()) {
      seen.push(received.kind === "event" ? received.event.type : received.kind);
      if (seen.length === 1) break;
    }
    expect(seen).toEqual(["usage_changed"]);
  });

  it("reports not_running without a start command", async () => {
    const dir = tempDir();
    expect(await connect({ dir, lockPath: join(dir, "engine.lock") })).toMatchObject({ ok: false, error: { code: "not_running" } });
  });

  it("refuses a relative engine dir", async () => {
    expect(await connect({ dir: "relative/run", lockPath: "/nowhere/engine.lock" })).toMatchObject({ ok: false, error: { code: "invalid_endpoint" } });
  });

  it("reports an engine's unsupported_version refusal", async () => {
    const fake = await fakeEngine(answering(`${JSON.stringify({ kind: "connection_error", apiVersion: 7, code: "unsupported_version", message: "engine speaks 7", runningItems: 2 })}\n`));
    expect(await open(fake)).toEqual({ ok: false, error: { code: "unsupported_version", message: "engine speaks 7", engine: { apiVersion: 7, runningItems: 2 } } });
  });

  it("reports the engine's build version and running items from its welcome", async () => {
    const fake = await fakeEngine(answering(welcome("e1", { engineVersion: "0.3.1", runningItems: 2 })));
    const connected = await open(fake);
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    expect(connected.value.engine).toEqual({ apiVersion: API_VERSION, engineVersion: "0.3.1", runningItems: 2 });
  });

  it("reports only the API version from a welcome that says no more", async () => {
    const fake = await fakeEngine(answering(welcome()));
    const connected = await open(fake);
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    expect(connected.value.engine).toEqual({ apiVersion: API_VERSION });
  });

  it("reports the build version of a refusing engine", async () => {
    const fake = await fakeEngine(answering(`${JSON.stringify({ kind: "connection_error", apiVersion: 7, code: "unsupported_version", message: "engine speaks 7", engineVersion: "0.1.0" })}\n`));
    expect(await open(fake)).toMatchObject({ ok: false, error: { engine: { apiVersion: 7, engineVersion: "0.1.0" } } });
  });

  it("reports an older engine's refusal without runningItems as not known", async () => {
    const fake = await fakeEngine(answering(`${JSON.stringify({ kind: "connection_error", apiVersion: 2, code: "unsupported_version", message: "engine speaks 2" })}\n`));
    expect(await open(fake)).toEqual({ ok: false, error: { code: "unsupported_version", message: "engine speaks 2", engine: { apiVersion: 2 } } });
  });

  it("requestShutdown sends the token in a shutdown request, and is true only when the engine accepts", async () => {
    const received: unknown[] = [];
    let answer = { kind: "shutdown_accepted", apiVersion: 9 } as object;
    const fake = await fakeEngine((socket) =>
      socket.once("data", (chunk) => {
        received.push(JSON.parse(chunk.toString()));
        socket.end(`${JSON.stringify(answer)}\n`);
      }),
    );
    const files = { socketPath: fake.socketPath, tokenPath: tokenPathOf(fake.socketPath) };
    expect(await requestShutdown(files)).toBe(true);
    expect(received).toEqual([{ kind: "shutdown", apiVersion: API_VERSION, token: "t0k" }]);
    // An engine from before the request answers it as a bad first message.
    answer = { kind: "connection_error", apiVersion: 4, code: "bad_message", message: "the first message must be a hello" };
    expect(await requestShutdown(files)).toBe(false);
  });

  it("requestShutdown is false when no engine answers, and never sends the token into an unsafe dir", async () => {
    const dir = tempDir();
    const files = { socketPath: join(dir, "s-1a2b3c4d.sock"), tokenPath: join(dir, "s-1a2b3c4d.token") };
    expect(await requestShutdown(files)).toBe(false);
    writeFileSync(files.tokenPath, "t0k");
    chmodSync(dir, 0o755);
    expect(await requestShutdown(files)).toBe(false);
    chmodSync(dir, 0o700);
  });

  it("refuses a welcome of another API version", async () => {
    const fake = await fakeEngine(answering(`${JSON.stringify({ kind: "welcome", apiVersion: API_VERSION + 1, engineId: "e1", runningItems: 0 })}\n`));
    expect(await open(fake)).toMatchObject({ ok: false, error: { code: "unsupported_version", engine: { apiVersion: API_VERSION + 1, runningItems: 0 } } });
  });

  it("refuses to send the token into a dir that others can read, or a symlinked dir", async () => {
    const fake = await fakeEngine(answering(welcome()));
    symlinkSync(fake.dir, `${fake.dir}-link`);
    cleanups.push(() => rmSync(`${fake.dir}-link`, { force: true }));
    // The lock names the socket through the link.
    const linked = join(tempDir(), "engine.lock");
    writeFileSync(linked, `${process.pid} e1 ${fake.dir}-link/s-1a2b3c4d.sock\n`, { mode: 0o600 });
    expect(await connect({ dir: fake.dir, lockPath: linked })).toMatchObject({ ok: false, error: { code: "unsafe_dir" } });

    chmodSync(fake.dir, 0o755);
    expect(await open(fake)).toMatchObject({ ok: false, error: { code: "unsafe_dir" } });
    chmodSync(fake.dir, 0o700);
    const connected = await open(fake);
    expect(connected.ok).toBe(true);
    if (connected.ok) cleanups.push(() => connected.value.close());
  });

  it("ignores a lock that group or others can write", async () => {
    const fake = await fakeEngine(answering(welcome()), { mode: 0o664 });
    expect(await open(fake)).toMatchObject({ ok: false, error: { code: "not_running" } });
    expect(fake.accepted()).toBe(0);
  });

  it("finds an engine of an earlier build through the lock, by the socket name it gave and the token next to it", async () => {
    // `$XDG_RUNTIME_DIR/tokama/engine.sock` with `engine.token`, named by the home lock.
    const fake = await fakeEngine(answering(welcome("e-old")), { dir: join(tempDir(), "xdg", "tokama"), name: "engine.sock" });
    const connected = await connect({ dir: tempDir(), lockPath: fake.lockPath });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    expect(connected.value.engineId).toBe("e-old");
  });

  it("finds an engine of an earlier build in the old run dir and stops it", async () => {
    const dir = join(tempDir(), "run");
    // It accepts the request and ends like an engine that exits: its lock goes.
    const fake = await fakeEngine(
      (socket) =>
        socket.once("data", () => {
          rmSync(join(dir, "engine.lock"), { force: true });
          socket.end(`${JSON.stringify({ kind: "shutdown_accepted", apiVersion: API_VERSION })}\n`);
        }),
      { dir, name: "engine.sock" },
    );
    let alive = true;
    const result = await stopEngine({
      lockPath: fake.lockPath,
      expectedEngineId: "e1",
      ifIdle: false,
      force: true,
      signal: () => {},
      probe: async () => (alive ? ((alive = false), "alive") : "dead"),
    });
    expect(result).toEqual({ kind: "stopped", forced: false });
  });

  it("reports an engine that exits before it serves, with its exit code and log", async () => {
    const dir = `${tempDir()}/run`;
    const start = { command: process.execPath, args: ["-e", "process.stderr.write('engine broke'); process.exit(1)"] };
    const connected = await connect({ dir, lockPath: join(dir, "engine.lock"), start, startTimeoutMs: 10_000 });
    expect(connected).toMatchObject({ ok: false, error: { code: "start_failed", message: expect.stringContaining("with code 1") } });
    expect(!connected.ok && connected.error.message).toContain(`${dir}/engine.log`);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(`${dir}/engine.log`).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${dir}/engine.log`, "utf8")).toContain("engine broke");
  });

  /** A start command that records that it ran; it never serves. */
  function recordingStart() {
    const marker = join(tempDir(), "started");
    return { start: { command: process.execPath, args: ["-e", `require("fs").appendFileSync(process.env.MARKER, "start\\n")`], env: { ...process.env, MARKER: marker } }, started: () => existsSync(marker) };
  }

  // An engine that is slow to open its item log accepts the connection at once and answers later.
  it("waits on the one connection of a slow engine and never starts another", async () => {
    const hello: Socket[] = [];
    const fake = await fakeEngine((socket) => socket.once("data", () => hello.push(socket)));
    const recorder = recordingStart();
    const connecting = open(fake, { start: recorder.start, startTimeoutMs: 10_000 });
    // The engine has the hello and says nothing for a while.
    while (hello.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 200));
    hello[0]?.write(welcome("e-slow"));
    const connected = await connecting;
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    expect(connected.value.engineId).toBe("e-slow");
    expect(fake.accepted()).toBe(1);
    expect(recorder.started()).toBe(false);
  });

  it("gives up on an engine that accepts and never answers, naming its pid, and starts none", async () => {
    const fake = await fakeEngine(() => {});
    const recorder = recordingStart();
    const connected = await open(fake, { start: recorder.start, startTimeoutMs: 300 });
    expect(connected).toMatchObject({ ok: false, error: { code: "start_failed", message: expect.stringContaining(`pid ${process.pid}`) } });
    expect(!connected.ok && connected.error.message).toContain("engine.log");
    expect(recorder.started()).toBe(false);
  });

  it("does not start an engine beside one that closes the connection without a welcome", async () => {
    const fake = await fakeEngine((socket) => socket.once("data", () => socket.end()));
    const recorder = recordingStart();
    expect(await open(fake, { start: recorder.start, startTimeoutMs: 400 })).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(recorder.started()).toBe(false);
  });

  /**
   * An engine that behaves like the real one around its lock: it listens first, then links its lock
   * (exit 3 when one exists, unless `takeover`: a lock whose socket is dead is replaced) and
   * answers every hello with a welcome after `delayMs`.
   */
  function scriptEngine(dir: string, options: { delayMs?: number; takeover?: boolean } = {}) {
    const starts = join(tempDir(), "starts");
    const pids = join(tempDir(), "pids");
    const engine = `const fs = require("fs"), net = require("net"), path = require("path");
      const dir = process.env.DIR, lock = process.env.LOCK, id = "e-" + process.pid;
      fs.appendFileSync(process.env.PIDS, process.pid + "\\n");
      const sock = path.join(dir, "s-" + process.pid + ".sock");
      fs.writeFileSync(sock.replace(/\\.sock$/, ".token"), "t0k");
      const welcome = JSON.stringify({ kind: "welcome", apiVersion: Number(process.env.API), engineId: id }) + "\\n";
      net.createServer((socket) => { socket.once("data", () => setTimeout(() => socket.write(welcome), Number(process.env.DELAY))); socket.on("error", () => {}); }).listen(sock, () => {
        const temp = lock + "." + process.pid + ".tmp";
        fs.writeFileSync(temp, process.pid + " " + id + " " + sock + "\\n", { mode: 0o600 });
        try {
          try { fs.linkSync(temp, lock); } catch (error) {
            if (process.env.TAKEOVER !== "1") { fs.appendFileSync(process.env.STARTS, "refused\\n"); process.exit(3); }
            fs.unlinkSync(lock); fs.linkSync(temp, lock);
          }
        } finally { fs.unlinkSync(temp); }
        fs.appendFileSync(process.env.STARTS, "start\\n");
        setTimeout(() => process.exit(0), 30_000);
      });`;
    // Only the fake engines' own pids, each while it still runs: it ends itself after 30 s.
    cleanups.push(() => {
      for (const pid of readFileSync(pids, { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean).map(Number)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
    const lockPath = join(dir, "engine.lock");
    const start = {
      command: process.execPath,
      args: ["-e", engine],
      env: { ...process.env, STARTS: starts, PIDS: pids, DIR: dir, LOCK: lockPath, DELAY: String(options.delayMs ?? 0), API: String(API_VERSION), TAKEOVER: options.takeover ? "1" : "0" },
    };
    return { start, lockPath, starts: () => readFileSync(starts, { encoding: "utf8", flag: "a+" }) };
  }

  it("starts an engine when no lock exists, waits for its lock, and connects", async () => {
    const dir = `${tempDir()}/run`;
    const engine = scriptEngine(dir);
    const connected = await connect({ dir, lockPath: engine.lockPath, start: engine.start, startTimeoutMs: 10_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    expect(connected.value.engineId).toMatch(/^e-\d+$/);
    expect(engine.starts()).toBe("start\n");
  });

  it("starts an engine when the lock names a socket that nobody listens on", async () => {
    const dir = `${tempDir()}/run`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dead = join(dir, "s-deadbeef.sock");
    writeFileSync(tokenPathOf(dead), "t0k");
    writeFileSync(join(dir, "engine.lock"), `${process.pid} e-dead ${dead}\n`, { mode: 0o600 });
    const engine = scriptEngine(dir, { takeover: true });
    const connected = await connect({ dir, lockPath: engine.lockPath, start: engine.start, startTimeoutMs: 10_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    expect(connected.value.engineId).not.toBe("e-dead");
    expect(engine.starts()).toBe("start\n");
  });

  it("ends two clients that start at once on one engine", async () => {
    const dir = `${tempDir()}/run`;
    const engine = scriptEngine(dir, { delayMs: 300 });
    const [first, second] = await Promise.all([1, 2].map(() => connect({ dir, lockPath: engine.lockPath, start: engine.start, startTimeoutMs: 15_000 })));
    for (const connected of [first, second]) {
      if (connected?.ok) cleanups.push(() => connected.value.close());
    }
    if (!first?.ok || !second?.ok) throw new Error(`${first?.ok === false ? first.error.message : ""} ${second?.ok === false ? second.error.message : ""}`);
    expect(first.value.engineId).toBe(second.value.engineId);
  });

  it("reconnects to an engine that comes back with another lock, and tells it", async () => {
    const dir = `${tempDir()}/run`;
    const first = await fakeEngine((socket) => socket.once("data", () => socket.write(welcome("e-first"))), { dir });
    const engine = scriptEngine(dir, { takeover: true });
    const connected = await connect({ dir, lockPath: engine.lockPath, start: engine.start });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    const done = (async () => {
      for await (const event of connected.value.events()) {
        if (event.kind === "reconnected" || event.kind === "failed") return event;
      }
      return undefined;
    })();
    // The first engine dies and leaves its lock; the client starts the next one over it.
    await first.close();
    expect(await done).toMatchObject({ kind: "reconnected" });
    expect(connected.value.engineId).not.toBe("e-first");
    expect(engine.starts()).toBe("start\n");
  });

  // The design rests on this: the kernel closes a listening socket when its process is killed, even
  // while a child of that process lives on.
  it("sees a socket as dead once its engine is killed with SIGKILL, though a child of it still runs", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "s-1a2b3c4d.sock");
    const script = `const net = require("net"), cp = require("child_process");
      net.createServer().listen(process.env.SOCK, () => {
        const child = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
        console.log(child.pid);
      });`;
    const engine = spawn(process.execPath, ["-e", script], { env: { ...process.env, SOCK: socketPath }, stdio: ["ignore", "pipe", "ignore"] });
    cleanups.push(() => engine.kill("SIGKILL"));
    const grandchild = await new Promise<number>((resolve) => engine.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
    cleanups.push(() => {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // Already gone.
      }
    });
    expect(await probeSocket(socketPath)).toBe("alive");
    const exited = new Promise<void>((resolve) => engine.once("exit", () => resolve()));
    engine.kill("SIGKILL");
    await exited;
    // The socket file is still there, and the grandchild still runs.
    expect(existsSync(socketPath)).toBe(true);
    expect(() => process.kill(grandchild, 0)).not.toThrow();
    expect(await probeSocket(socketPath)).toBe("dead");
  });

  // Bug #75: Electron on Linux leaves pipes open in its children; an engine that kept them held the
  // pipes of Playwright, which then never saw the app close. A host process stands in for Electron.
  it("starts the engine without the open descriptors of its parent", () => {
    const dir = `${tempDir()}/run`;
    const probe = join(tempDir(), "fds");
    const engine = `const fs = require("fs"); fs.writeFileSync(process.env.PROBE, [3, 4].map((fd) => { try { const stat = fs.fstatSync(fd); return stat.isFIFO() || stat.isSocket() ? "pipe" : "other"; } catch { return "closed"; } }).join(" "));`;
    const host = `const { connect } = await import(process.env.CLIENT);
      await connect({ dir: process.env.DIR, lockPath: process.env.DIR + "/engine.lock", start: { command: process.execPath, args: ["-e", ${JSON.stringify(engine)}], env: process.env }, startTimeoutMs: 10_000 });`;
    // "pipe" entries past stderr give the host descriptors 3 and 4 that its children inherit unless told otherwise.
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", host], {
      env: { ...process.env, CLIENT: fileURLToPath(new URL("../dist/index.js", import.meta.url)), DIR: dir, PROBE: probe },
      stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
      timeout: 20_000,
    });
    expect(ran.status).toBe(0);
    expect(readFileSync(probe, "utf8")).toBe("other other");
  });

  it("reports a protocol error when the engine does not answer the hello", async () => {
    const fake = await fakeEngine(answering("hello there\n"));
    expect(await open(fake)).toMatchObject({ ok: false, error: { code: "protocol_error" } });
  });
});
