// The engine service: serves the engine API on a user-owned Unix domain socket.
//
// Start order: a 0700 directory owned by the user, then the single-instance lock, then a new
// per-session token (0600 file), then the socket (0600). Each connection starts with a hello
// carrying the token and the client's API version; after the welcome, the client sends commands
// and queries (one JSON message per line) and receives replies and events.
//
// Shutdown, when the signal aborts or close() is called: refuse new connections, wait for
// in-flight requests (bounded), close the connections, stop listening, then remove the socket,
// token and lock files if the lock is still this engine's. The socket keeps answering until the
// drain ends, so an engine starting meanwhile sees a live engine instead of a stale lock.
// Threat model: local desktop, no network listener.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  API_VERSION,
  type BoardResult,
  checkEngineDir,
  type Clock,
  type CommandErrorCode,
  type ConnectionErrorCode,
  type ClientMessage,
  encodeLine,
  type EngineEndpoint,
  engineEndpoint,
  err,
  type ItemResult,
  LineDecoder,
  MAX_MESSAGE_BYTES,
  ok,
  parseClientMessage,
  parseHelloMessage,
  type ParseError,
  type Result,
  type SuggestTemplateResult,
  systemClock,
  type SetupResult,
  ItemStore,
  loadHostId,
  posixProcessTable,
  type ProcessTable,
  recoverItems,
} from "@tokama/core";
import { ItemIndex } from "./item-index.js";
import { SampleEngine } from "./sample/sample.js";
import { MemoryItemStore } from "./store.js";

export interface EngineOptions {
  /** Directory for the socket, token and lock; created with mode 0700 if missing. */
  readonly dir: string;
  /** Aborting it shuts the engine down. */
  readonly signal?: AbortSignal;
  readonly store?: MemoryItemStore;
  /** Fake engine mode: serve the sample data set and handle commands on it (sample/sample.ts). */
  readonly sample?: boolean;
  /**
   * Tokama's home folder (`~/.tokama`): item logs in `items/`, the board index in `tokama.db`.
   * Without it, or in sample mode, nothing is stored.
   */
  readonly home?: string;
  /** Read and signal leftover agent processes on start. Default: the POSIX process table. */
  readonly processTable?: ProcessTable;
  /** Default: the system clock. */
  readonly clock?: Clock;
  /** A connection that sends no hello within this time is closed. Default 5 s. */
  readonly helloTimeoutMs?: number;
  /** How long shutdown waits for in-flight requests and open connections. Default 5 s. */
  readonly shutdownTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface EngineHandle {
  /** New on each start; clients see it in the welcome and resync when it changes. */
  readonly engineId: string;
  readonly endpoint: EngineEndpoint;
  readonly store: MemoryItemStore;
  /** The item logs, when the engine stores items. */
  readonly items?: ItemStore;
  /** Resolves once the engine has shut down and removed its files. */
  readonly closed: Promise<void>;
  /** Shuts the engine down, as aborting the signal does. */
  close(): Promise<void>;
}

export interface StartError {
  readonly code: "already_running" | "invalid_endpoint" | "unsafe_dir" | "start_failed";
  readonly message: string;
}

type ReplyResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

// A lock whose pid is alive but whose socket does not answer belongs to an engine still starting,
// unless it is older than this (the pid was then reused after a crash).
const STARTING_GRACE_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_000;
// A client that stops reading is disconnected once this much output is queued for it.
const MAX_QUEUED_BYTES = 8 * MAX_MESSAGE_BYTES;

export async function startEngine(options: EngineOptions): Promise<Result<EngineHandle, StartError>> {
  const log = options.log ?? (() => {});
  const endpoint = engineEndpoint(options.dir);
  if (!endpoint.ok) return err({ code: "invalid_endpoint", message: endpoint.error.message });
  const { socketPath, tokenPath, lockPath } = endpoint.value;

  const dir = ensurePrivateDir(endpoint.value.dir);
  if (!dir.ok) return dir;
  const engineId = randomUUID();
  // Unique per engine instance (two engines in one process share the pid).
  const lockContent = `${process.pid} ${engineId}\n`;
  const lock = await acquireLock(endpoint.value, lockContent, log);
  if (!lock.ok) return lock;

  // Only the engine that holds the lock opens the item store, so a second engine starting never
  // runs recovery against the live engine's agents.
  let storage: Storage | undefined;
  if (options.home !== undefined && !options.sample) {
    const opened = await openStorage(options.home, options.processTable ?? posixProcessTable, options.clock ?? systemClock, log);
    if (!opened.ok) {
      releaseLock(lockPath, lockContent);
      return opened;
    }
    storage = opened.value;
  }

  // From here on the lock is ours, so the socket and token files at these paths are ours too.
  let server: Server;
  let token: Buffer;
  try {
    unlinkIfPresent(socketPath);
    token = writeToken(tokenPath);
    server = await listen(socketPath);
    chmodSync(socketPath, 0o600);
  } catch (error) {
    storage?.close();
    unlinkIfPresent(socketPath);
    unlinkIfPresent(tokenPath);
    releaseLock(lockPath, lockContent);
    return err({ code: "start_failed", message: `could not listen on ${socketPath}: ${String(error)}` });
  }

  const store = options.store ?? new MemoryItemStore();
  const sample = options.sample ? new SampleEngine(store, options.clock ?? systemClock) : undefined;
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const connections = new Set<Socket>();
  const ready = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  let seq = 0;
  let shuttingDown = false;
  let onAllClosed: (() => void) | undefined;

  const write = (socket: Socket, line: string) => {
    if (socket.destroyed || socket.writableEnded) return;
    socket.write(line);
    if (socket.writableLength > MAX_QUEUED_BYTES) {
      log("disconnecting a client that stopped reading");
      socket.destroy();
    }
  };

  /** Sends a connection-level error, then closes the connection. */
  const fail = (socket: Socket, code: ConnectionErrorCode, message: string) => {
    ready.delete(socket);
    const line = encodeLine({ kind: "connection_error", apiVersion: API_VERSION, code, message });
    if (line.ok) write(socket, line.value);
    socket.end();
    // Do not wait on a peer that keeps the connection open.
    setTimeout(() => socket.destroy(), 1_000).unref();
  };

  const reply = (socket: Socket, requestId: string, result: ReplyResult) => {
    const line = encodeLine({ apiVersion: API_VERSION, kind: "reply", requestId, result });
    if (line.ok) return write(socket, line.value);
    const tooLarge = encodeLine({
      apiVersion: API_VERSION,
      kind: "reply",
      requestId,
      result: { ok: false, error: { code: "reply_too_large", message: `the reply is larger than ${MAX_MESSAGE_BYTES} bytes` } },
    });
    if (tooLarge.ok) write(socket, tooLarge.value);
  };

  const dispatch = async (message: ClientMessage): Promise<ReplyResult> => {
    if (message.kind === "command") {
      if (!sample) {
        const code: CommandErrorCode = "not_implemented";
        return { ok: false, error: { code, message: `command "${message.command.type}" is not implemented yet` } };
      }
      const result = sample.command(message.command);
      return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
    }
    const query = message.query;
    switch (query.type) {
      case "setup":
        return { ok: true, data: (sample?.setup ?? { repos: [], connections: [], agents: [], templates: [] }) satisfies SetupResult };
      case "board":
        return { ok: true, data: { items: store.list() } satisfies BoardResult };
      case "item": {
        const item = store.get(query.itemId);
        return item ? { ok: true, data: { item } satisfies ItemResult } : { ok: false, error: { code: "not_found", message: `no item ${query.itemId}` } };
      }
      case "suggest_template":
        return { ok: true, data: { templateId: sample?.suggestTemplate(query.text) ?? null } satisfies SuggestTemplateResult };
    }
  };

  const handleHello = (socket: Socket, line: string): boolean => {
    const hello = parseHelloMessage(parseJson(line));
    if (!hello.ok) {
      fail(socket, "bad_message", "the first message must be a hello");
      return false;
    }
    if (!sameToken(token, hello.value.token)) {
      fail(socket, "unauthorized", "wrong engine token");
      return false;
    }
    if (hello.value.apiVersion !== API_VERSION) {
      fail(socket, "unsupported_version", `engine speaks API version ${API_VERSION}, client sent ${hello.value.apiVersion}`);
      return false;
    }
    const welcome = encodeLine({ kind: "welcome", apiVersion: API_VERSION, engineId });
    if (welcome.ok) write(socket, welcome.value);
    ready.add(socket);
    return true;
  };

  const handleMessage = (socket: Socket, line: string) => {
    const json = parseJson(line);
    const parsed = parseClientMessage(json);
    if (!parsed.ok) {
      const requestId = requestIdOf(json);
      const message = describe(parsed.error);
      if (requestId === undefined) return fail(socket, "bad_message", message);
      return reply(socket, requestId, { ok: false, error: { code: "invalid_message", message } });
    }
    const work = dispatch(parsed.value)
      .catch((error: unknown): ReplyResult => {
        log(`request failed: ${String(error)}`);
        return { ok: false, error: { code: "internal", message: "the engine failed to handle the request" } };
      })
      .then((result) => reply(socket, parsed.value.requestId, result));
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  // An accept error (e.g. EMFILE) must not end the engine; the server keeps listening.
  server.on("error", (error) => log(`socket server error: ${String(error)}`));

  server.on("connection", (socket) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    const decoder = new LineDecoder();
    let welcomed = false;
    const helloTimer = setTimeout(() => fail(socket, "hello_timeout", `no hello within ${helloTimeoutMs} ms`), helloTimeoutMs);
    helloTimer.unref();
    socket.on("data", (chunk: Buffer) => {
      if (socket.writableEnded) return;
      const lines = decoder.push(chunk);
      if (!lines.ok) return fail(socket, "message_too_large", `messages are limited to ${MAX_MESSAGE_BYTES} bytes`);
      for (const line of lines.value) {
        if (socket.writableEnded) return;
        if (welcomed) {
          handleMessage(socket, line);
          continue;
        }
        clearTimeout(helloTimer);
        welcomed = handleHello(socket, line);
      }
    });
    // A close event always follows an error; nothing else to do here.
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(helloTimer);
      connections.delete(socket);
      ready.delete(socket);
      if (connections.size === 0) onAllClosed?.();
    });
  });

  // Events go out only when something changes; there is no heartbeat.
  const unsubscribe = store.subscribe((item) => {
    const line = encodeLine({ apiVersion: API_VERSION, kind: "event", seq: seq++, event: { type: "item_updated", item } });
    if (!line.ok) return log(`dropped an event larger than ${MAX_MESSAGE_BYTES} bytes`);
    for (const socket of ready) write(socket, line.value);
  });

  const stopTicking = sample?.startTicking();

  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const shutdown = async () => {
    if (shuttingDown) return closed;
    shuttingDown = true;
    stopTicking?.();
    unsubscribe();
    await withDeadline(Promise.allSettled([...inFlight]), shutdownTimeoutMs);
    const allClosed = new Promise<void>((resolve) => {
      onAllClosed = resolve;
      if (connections.size === 0) resolve();
    });
    for (const socket of connections) socket.end();
    await withDeadline(allClosed, shutdownTimeoutMs);
    for (const socket of connections) socket.destroy();
    // Closing the server removes the socket file. Only then may another engine take over.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage?.close();
    if (ownsLock(lockPath, lockContent)) {
      unlinkIfPresent(socketPath);
      unlinkIfPresent(tokenPath);
      releaseLock(lockPath, lockContent);
    }
    log("stopped");
    resolveClosed();
    return closed;
  };

  if (options.signal?.aborted) void shutdown();
  else options.signal?.addEventListener("abort", () => void shutdown(), { once: true });

  log(`listening on ${socketPath} (engine ${engineId}${sample ? ", sample data" : ""})`);
  return ok({ engineId, endpoint: endpoint.value, store, ...(storage && { items: storage.items }), closed, close: shutdown });
}

interface Storage {
  readonly items: ItemStore;
  close(): void;
}

/**
 * Loads the item logs, rebuilds the board index from them, then recovers the steps that were
 * running when the engine stopped. The index follows every change after that.
 */
async function openStorage(home: string, table: ProcessTable, clock: Clock, log: (message: string) => void): Promise<Result<Storage, StartError>> {
  let index: ItemIndex | undefined;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const hostId = loadHostId(home, clock);
    if (!hostId.ok) return err({ code: "start_failed", message: hostId.error });
    const { store: items, problems } = ItemStore.open({ home, hostId: hostId.value, clock });
    for (const problem of problems) log(`item ${problem.itemId} is not loaded: ${problem.message}`);
    index = ItemIndex.open(join(home, "tokama.db"));
    index.rebuild(items.list());
    const opened = index;
    const unsubscribe = items.subscribe((item) => opened.put(item));
    for (const recovered of await recoverItems(items, { table, clock })) {
      const kills = recovered.kills.map(({ pid, outcome }) => `${pid} ${outcome.kind}${"reason" in outcome ? ` (${outcome.reason})` : ""}${"message" in outcome ? ` (${outcome.message})` : ""}`);
      log(`item ${recovered.itemId}: step ${recovered.stepId} was running; asking retry or stop${kills.length > 0 ? `; processes: ${kills.join(", ")}` : ""}${recovered.error ? `; not recorded: ${recovered.error.message}` : ""}`);
    }
    return ok({
      items,
      close: () => {
        unsubscribe();
        opened.close();
      },
    });
  } catch (error) {
    index?.close();
    return err({ code: "start_failed", message: `cannot open item storage in ${home}: ${String(error)}` });
  }
}

function ensurePrivateDir(dir: string): Result<void, StartError> {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let check = checkEngineDir(dir);
    // Our own directory with a loose mode is fixed; anything else is refused.
    if (!check.ok && check.error.code === "too_open") {
      chmodSync(dir, 0o700);
      check = checkEngineDir(dir);
    }
    return check.ok ? check : err({ code: "unsafe_dir", message: check.error.message });
  } catch (error) {
    return err({ code: "unsafe_dir", message: `cannot prepare ${dir}: ${String(error)}` });
  }
}

async function acquireLock(endpoint: EngineEndpoint, content: string, log: (message: string) => void): Promise<Result<void, StartError>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(endpoint.lockPath, "wx", 0o600);
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return ok(undefined);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) return err({ code: "start_failed", message: `cannot create ${endpoint.lockPath}: ${String(error)}` });
    }
    if (await lockIsLive(endpoint)) {
      return err({ code: "already_running", message: `an engine is already running on ${endpoint.socketPath}` });
    }
    log(`removing a stale lock and socket in ${endpoint.dir}`);
    unlinkIfPresent(endpoint.lockPath);
  }
  return err({ code: "already_running", message: `another engine is starting in ${endpoint.dir}` });
}

async function lockIsLive(endpoint: EngineEndpoint): Promise<boolean> {
  if (await socketAnswers(endpoint.socketPath)) return true;
  let content: string;
  let ageMs: number;
  try {
    content = readFileSync(endpoint.lockPath, "utf8");
    ageMs = Date.now() - lstatSync(endpoint.lockPath).mtimeMs;
  } catch {
    return false;
  }
  const pid = Number.parseInt(content, 10);
  if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return false;
  return ageMs < STARTING_GRACE_MS;
}

/** True when something accepts connections on the socket (or it does not answer in time). */
function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const done = (answers: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answers);
    };
    const timer = setTimeout(() => done(true), PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return hasCode(error, "EPERM");
  }
}

function ownsLock(lockPath: string, content: string): boolean {
  try {
    return readFileSync(lockPath, "utf8") === content;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string, content: string): void {
  if (!ownsLock(lockPath, content)) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/** Writes a new random token to a 0600 file; atomic, so a client never reads half a token. */
function writeToken(tokenPath: string): Buffer {
  const token = randomBytes(32).toString("hex");
  const tempPath = `${tokenPath}.${process.pid}.tmp`;
  unlinkIfPresent(tempPath);
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, tokenPath);
  return Buffer.from(token);
}

function listen(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function sameToken(expected: Buffer, given: string): boolean {
  const candidate = Buffer.from(given);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function requestIdOf(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null || !("requestId" in json)) return undefined;
  const { requestId } = json;
  return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128 ? requestId : undefined;
}

function describe(error: ParseError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ")
    .slice(0, 1000);
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
