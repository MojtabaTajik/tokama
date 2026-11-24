// The engine service: serves the engine API on a user-owned Unix domain socket.
//
// Start order: a 0700 directory owned by the user, then the single-instance lock, then a new
// per-session token (0600 file), then the socket (0600). Each connection starts with a hello
// carrying the token and the client's API version; after the welcome, the client sends commands
// and queries (one JSON message per line) and receives replies and events.
//
// Shutdown, when the signal aborts or close() is called: stop accepting, wait for in-flight
// requests (bounded), close the connections, remove the socket, token and lock files.
// Threat model: architecture.md, section 9 (local desktop, no network listener).
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
  API_VERSION,
  type ConnectionErrorCode,
  type ClientMessage,
  encodeLine,
  type EngineEndpoint,
  engineEndpoint,
  err,
  LineDecoder,
  MAX_MESSAGE_BYTES,
  ok,
  parseClientMessage,
  parseHelloMessage,
  type ParseError,
  type Result,
} from "@tokama/core";
import { MemoryItemStore } from "./store.js";

export interface EngineOptions {
  /** Directory for the socket, token and lock; created with mode 0700 if missing. */
  readonly dir: string;
  /** Aborting it shuts the engine down. */
  readonly signal?: AbortSignal;
  readonly store?: MemoryItemStore;
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
  const lock = await acquireLock(endpoint.value, log);
  if (!lock.ok) return lock;

  // From here on the lock is ours, so the socket and token files at these paths are ours too.
  let server: Server;
  let token: Buffer;
  try {
    unlinkIfPresent(socketPath);
    token = writeToken(tokenPath);
    server = await listen(socketPath);
    chmodSync(socketPath, 0o600);
  } catch (error) {
    unlinkIfPresent(socketPath);
    unlinkIfPresent(tokenPath);
    releaseLock(lockPath);
    return err({ code: "start_failed", message: `could not listen on ${socketPath}: ${String(error)}` });
  }

  const engineId = randomUUID();
  const store = options.store ?? new MemoryItemStore();
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const connections = new Set<Socket>();
  const ready = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  let seq = 0;
  let shuttingDown = false;

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
      return { ok: false, error: { code: "not_implemented", message: `command "${message.command.type}" is not implemented yet` } };
    }
    const query = message.query;
    switch (query.type) {
      case "board":
        return { ok: true, data: { items: store.list(query.workspaceId) } };
      case "item": {
        const item = store.get(query.itemId);
        return item ? { ok: true, data: { item } } : { ok: false, error: { code: "not_found", message: `no item ${query.itemId}` } };
      }
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
    });
  });

  // Events go out only when something changes; there is no heartbeat.
  const unsubscribe = store.subscribe((item) => {
    const line = encodeLine({ apiVersion: API_VERSION, kind: "event", seq: seq++, event: { type: "item_updated", item } });
    if (!line.ok) return log(`dropped an event larger than ${MAX_MESSAGE_BYTES} bytes`);
    for (const socket of ready) write(socket, line.value);
  });

  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const shutdown = async () => {
    if (shuttingDown) return closed;
    shuttingDown = true;
    unsubscribe();
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    await withDeadline(Promise.allSettled([...inFlight]), shutdownTimeoutMs);
    for (const socket of connections) socket.end();
    await withDeadline(serverClosed, shutdownTimeoutMs);
    for (const socket of connections) socket.destroy();
    await serverClosed;
    unlinkIfPresent(socketPath);
    unlinkIfPresent(tokenPath);
    releaseLock(lockPath);
    log("stopped");
    resolveClosed();
    return closed;
  };

  if (options.signal?.aborted) void shutdown();
  else options.signal?.addEventListener("abort", () => void shutdown(), { once: true });

  log(`listening on ${socketPath} (engine ${engineId})`);
  return ok({ engineId, endpoint: endpoint.value, store, closed, close: shutdown });
}

function ensurePrivateDir(dir: string): Result<void, StartError> {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) return err({ code: "unsafe_dir", message: `${dir} is not a directory (or is a symlink)` });
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return err({ code: "unsafe_dir", message: `${dir} is not owned by the current user` });
    if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    return ok(undefined);
  } catch (error) {
    return err({ code: "unsafe_dir", message: `cannot prepare ${dir}: ${String(error)}` });
  }
}

async function acquireLock(endpoint: EngineEndpoint, log: (message: string) => void): Promise<Result<void, StartError>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(endpoint.lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
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

function releaseLock(lockPath: string): void {
  try {
    if (Number.parseInt(readFileSync(lockPath, "utf8"), 10) === process.pid) unlinkSync(lockPath);
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
