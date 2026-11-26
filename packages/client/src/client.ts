// Typed client of the engine API over the local socket.
//
// connect() finds the engine through its lock, reads the token that sits next to the lock's
// socket, sends a hello and waits for the welcome. An accepted connection means that an engine
// lives, however long it takes to answer (it may be opening a large item log): the client keeps
// that one connection and waits for the welcome until the start timeout, then gives up and names
// the engine's pid. A refused connection or a missing socket means the engine is dead. When there
// is no engine and a start command is given, the client starts one (detached, so it outlives the
// client) and waits for the lock it publishes; it never starts a second one while the first still
// runs. After a lost connection the client reconnects on its own (starting the engine again when
// it can) and emits `reconnected`: the engine may have restarted and `seq` restarted with it, so
// the consumer re-runs its queries. Requests in flight when the connection drops fail with
// `disconnected`; they are never resent, because commands are not idempotent.
//
// A started engine's output goes to `engine.log` in the engine dir. If it exits before a
// connection with a code other than 3 ("an engine already runs", so another one won), the client
// gives up at once and names the exit code and the log.
import { mkdirSync, readFileSync } from "node:fs";
import { connect as connectSocket, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  API_VERSION,
  checkEngineDir,
  type ChildProcess,
  type ClientMessageInput,
  type CommandInput,
  type CommandResult,
  type CommandType,
  defaultEngineDir,
  encodeLine,
  hasCode,
  type EngineEndpoint,
  engineEndpoint,
  type EngineLock,
  type EngineEvent,
  err,
  LineDecoder,
  ok,
  parseClientMessage,
  parseCommandResult,
  isUnknownEvent,
  parseHandshakeReply,
  parseJsonLine,
  parseQueryResult,
  parseServerMessage,
  spawnDetached,
  parseShutdownReply,
  probeSocket,
  readEngineLock,
  tokenPathOf,
  type QueryInput,
  type QueryResult,
  type QueryType,
  type ReplyMessage,
  type Result,
} from "@tokama/core";

export interface EngineCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Environment of the engine process. Default: this process's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ConnectOptions {
  /** Where an engine this client starts runs, and its `engine.log`. Default: `defaultEngineDir()` (TOKAMA_ENGINE_DIR or ~/.tokama/run). */
  readonly dir?: string;
  /** The engine's lock file, from `engineLockPath`: a client finds the engine only through it, never by guessing a socket. */
  readonly lockPath: string;
  /** How to start the engine when it is not running. Without it, the client never starts one. */
  readonly start?: EngineCommand;
  /**
   * The one limit of the first connect: how long it waits for an engine to start, or for one that
   * accepted the connection to answer. Default 2 min with `start`, 10 s without it.
   */
  readonly startTimeoutMs?: number;
  /** Default timeout of one request. Default 30 s. */
  readonly requestTimeoutMs?: number;
  /** Reconnect after a lost connection. Default true. */
  readonly reconnect?: boolean;
}

export type ConnectErrorCode =
  | "invalid_endpoint"
  | "unsafe_dir"
  | "not_running"
  | "start_failed"
  | "timeout"
  | "unauthorized"
  | "unsupported_version"
  | "protocol_error";

/** What the engine said about itself in its handshake reply. */
export interface EngineInfo {
  readonly apiVersion: number;
  /** Its build version; absent from an engine too old to say. */
  readonly engineVersion?: string;
  /** How many items it ran at that moment; absent from an engine too old to say. */
  readonly runningItems?: number;
}

export interface ConnectError {
  readonly code: ConnectErrorCode;
  readonly message: string;
  /** With `unsupported_version`: what the running engine said about itself (its API version, build version and running items). */
  readonly engine?: EngineInfo;
}

/** A reply's result: `data` on success, or an error code such as `not_found`, `not_implemented`, `disconnected`, `timeout`. */
export type RequestResult = ReplyMessage["result"];
type RequestError = Extract<RequestResult, { ok: false }>;

/** A query's result, with `data` parsed for that query type (`invalid_reply` if it does not match). */
export type QueryReply<T extends QueryType> = { readonly ok: true; readonly data: QueryResult<T> } | RequestError;
/** A command's result, with `data` parsed for that command type (`invalid_reply` if it does not match). */
export type CommandReply<T extends CommandType> = { readonly ok: true; readonly data: CommandResult<T> } | RequestError;

export type ClientEvent =
  | { readonly kind: "event"; readonly seq: number; readonly event: EngineEvent }
  /** The connection dropped; the client is reconnecting. */
  | { readonly kind: "disconnected" }
  /** Connected again. State may have changed while away and `seq` may have restarted: re-run queries. */
  | { readonly kind: "reconnected"; readonly engineId: string }
  /** The client gave up (for example the engine refused the token); no more events follow. */
  | { readonly kind: "failed"; readonly error: ConnectError };

export interface RequestOptions {
  readonly timeoutMs?: number;
}

export interface EngineClient {
  /** The engine this client is connected to, or was connected to last. */
  readonly engineId: string;
  /** The handshake of the connection it has now, or had last. */
  readonly engine: EngineInfo;
  query<Q extends QueryInput>(query: Q, options?: RequestOptions): Promise<QueryReply<Q["type"]>>;
  command<C extends CommandInput>(command: C, options?: RequestOptions): Promise<CommandReply<C["type"]>>;
  /** Events from the time of this call on. The iteration ends when the client closes or fails. */
  events(): AsyncIterable<ClientEvent>;
  close(): Promise<void>;
}

const TERMINAL: ReadonlySet<ConnectErrorCode> = new Set([
  "unsafe_dir",
  "unauthorized",
  "unsupported_version",
  "protocol_error",
  "start_failed",
]);
const START_TIMEOUT_MS = 120_000;
const PROBE_ONLY_TIMEOUT_MS = 10_000;
/** Exit code of an engine that found another engine running: not a failure. */
const EXIT_ALREADY_RUNNING = 3;

export async function connect(options: ConnectOptions): Promise<Result<EngineClient, ConnectError>> {
  const endpoint = engineEndpoint(options.dir ?? defaultEngineDir(process.env, homedir()));
  if (!endpoint.ok) return err({ code: "invalid_endpoint", message: endpoint.error.message });
  const client = new Client(endpoint.value, options.lockPath, options);
  const opened = await client.open();
  return opened.ok ? ok(client) : opened;
}

interface SessionHandlers {
  onLine(line: string): void;
  onClose(): void;
}

interface Session {
  readonly socket: Socket;
  readonly engineId: string;
  readonly engine: EngineInfo;
}

interface Subscriber {
  push(event: ClientEvent): void;
  end(): void;
}

class Client implements EngineClient {
  engineId = "";
  engine: EngineInfo = { apiVersion: API_VERSION };
  private socket: Socket | undefined;
  private readonly pending = new Map<string, (result: RequestResult) => void>();
  private readonly subscribers = new Set<Subscriber>();
  private closing = false;
  private nextRequest = 0;
  /** The engine this client started and has not connected to yet. */
  private child: ChildProcess | undefined;
  private startError: string | undefined;
  /** How long to wait before the next try while the engine closes connections (it is stopping). */
  private drainDelayMs = 50;
  private readonly wakeups = new Set<() => void>();

  constructor(
    private readonly endpoint: EngineEndpoint,
    private readonly lockPath: string,
    private readonly options: ConnectOptions,
  ) {}

  private get limitMs(): number {
    return this.options.startTimeoutMs ?? (this.options.start ? START_TIMEOUT_MS : PROBE_ONLY_TIMEOUT_MS);
  }

  /** First connection: start the engine if needed and wait for it. */
  async open(): Promise<Result<void, ConnectError>> {
    const deadline = Date.now() + this.limitMs;
    for (;;) {
      const attempt = await this.attempt(Math.max(deadline - Date.now(), 0));
      if (attempt.ok || TERMINAL.has(attempt.error.code)) return attempt;
      if (!this.options.start) return attempt;
      if (Date.now() >= deadline) return err({ code: "timeout", message: `the engine did not start: ${attempt.error.message}` });
      await this.sleep(50);
    }
  }

  async query<Q extends QueryInput>(query: Q, options?: RequestOptions): Promise<QueryReply<Q["type"]>> {
    const reply = await this.request({ apiVersion: API_VERSION, kind: "query", requestId: this.requestId(), query }, options);
    if (!reply.ok) return reply;
    const data = parseQueryResult<Q["type"]>(query.type, reply.data);
    if (data.ok) return { ok: true, data: data.value };
    return failure("invalid_reply", `the engine sent ${query.type} data of the wrong shape`) as RequestError;
  }

  async command<C extends CommandInput>(command: C, options?: RequestOptions): Promise<CommandReply<C["type"]>> {
    const reply = await this.request({ apiVersion: API_VERSION, kind: "command", requestId: this.requestId(), command }, options);
    if (!reply.ok) return reply;
    const data = parseCommandResult<C["type"]>(command.type, reply.data);
    if (data.ok) return { ok: true, data: data.value };
    return failure("invalid_reply", `the engine sent ${command.type} data of the wrong shape`) as RequestError;
  }

  events(): AsyncIterable<ClientEvent> {
    const queue: ClientEvent[] = [];
    let ended = this.closing;
    let wake: (() => void) | undefined;
    const subscriber: Subscriber = {
      push: (event) => {
        queue.push(event);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    if (!ended) this.subscribers.add(subscriber);
    const next = async (): Promise<IteratorResult<ClientEvent>> => {
      while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
      const event = queue.shift();
      return event ? { done: false, value: event } : { done: true, value: undefined };
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next,
        return: async () => {
          this.subscribers.delete(subscriber);
          subscriber.end();
          return { done: true, value: undefined };
        },
      }),
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const wakeup of this.wakeups) wakeup();
    this.endSubscribers();
    const socket = this.socket;
    this.socket = undefined;
    this.failPending("disconnected", "the client was closed");
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
        setTimeout(() => socket.destroy(), 1_000).unref();
      });
    }
  }

  private requestId(): string {
    return `r${++this.nextRequest}`;
  }

  private request(message: ClientMessageInput, options: RequestOptions | undefined): Promise<RequestResult> {
    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      const detail = parsed.error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      return Promise.resolve(failure("invalid_request", detail));
    }
    const socket = this.socket;
    if (!socket || this.closing) return Promise.resolve(failure("disconnected", "not connected to the engine"));
    const line = encodeLine(message);
    if (!line.ok) return Promise.resolve(failure("message_too_large", `requests are limited to ${line.error.maxBytes} bytes`));
    const { requestId } = message;
    const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(failure("timeout", `no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(requestId, (result) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(result);
      });
      socket.write(line.value);
    });
  }

  /**
   * One connection attempt, through the lock. An engine whose socket accepts is waited for on that
   * one connection, up to `limitMs`, and never replaced. With no lock, or one whose socket is dead,
   * the client starts an engine when it has a start command and none of its own is still running.
   */
  private async attempt(limitMs: number): Promise<Result<void, ConnectError>> {
    if (this.startError) return err({ code: "start_failed", message: this.startError });
    const lock = readEngineLock(this.lockPath);
    let none: ConnectError = { code: "not_running", message: `no engine is running (no lock at ${this.lockPath})` };
    if (lock !== undefined) {
      const reached = await this.reach(lock, limitMs);
      if (reached.kind === "done") return reached.result;
      none = reached.error;
    }
    const start = this.options.start;
    if (!start) return err(none);
    // The engine started last has not published its lock yet, or has exited with code 3 and the
    // winner's lock is next: wait for it, never start another beside it.
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) return err(none);
    const started = this.startEngine(start);
    return started.ok ? err(none) : started;
  }

  /** Connects to the engine the lock names: connected or failed for good (`done`), or `dead` when nothing listens. */
  private async reach(lock: EngineLock, limitMs: number): Promise<{ readonly kind: "done"; readonly result: Result<void, ConnectError> } | { readonly kind: "dead"; readonly error: ConnectError }> {
    const session = await openSession({ socketPath: lock.socketPath, tokenPath: tokenPathOf(lock.socketPath) }, limitMs, {
      onLine: (line) => this.onLine(line),
      onClose: () => this.onClose(),
    });
    if (session.ok) {
      if (this.closing) {
        session.value.socket.destroy();
        return { kind: "done", result: err({ code: "not_running", message: "the client was closed" }) };
      }
      this.socket = session.value.socket;
      this.engineId = session.value.engineId;
      this.engine = session.value.engine;
      this.child = undefined;
      this.drainDelayMs = 50;
      return { kind: "done", result: ok(undefined) };
    }
    const { reason, ...error } = session.error;
    if (reason === "dead") return { kind: "dead", error };
    if (reason === "no_token") {
      // The token is written before the socket listens, but an engine of an earlier build writes it
      // after its lock. With a socket that accepts, an engine lives (or is starting): never start one beside it.
      if ((await probeSocket(lock.socketPath)) === "dead") return { kind: "dead", error };
      return { kind: "done", result: err({ code: "timeout", message: error.message }) };
    }
    if (reason === "closed") {
      // The engine took the connection and closed it without a welcome: it is stopping. Never start one beside it.
      await this.sleep(this.drainDelayMs);
      this.drainDelayMs = Math.min(this.drainDelayMs * 2, 1_000);
    }
    // Something other than "nothing listens" went wrong: that is not the same as no engine.
    if (error.code === "not_running" && reason === undefined) return { kind: "done", result: err({ code: "timeout", message: error.message }) };
    if (reason === "silent") {
      const message = `The engine (pid ${lock.pid}) does not answer; see ${this.endpoint.logPath}`;
      return { kind: "done", result: err({ code: this.options.start ? "start_failed" : "timeout", message }) };
    }
    return { kind: "done", result: err(error) };
  }

  private startEngine(start: EngineCommand): Result<void, ConnectError> {
    const { dir, logPath } = this.endpoint;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return err({ code: "start_failed", message: `cannot prepare ${logPath}: ${String(error)}` });
    }
    const check = checkEngineDir(dir);
    if (!check.ok) return err({ code: "unsafe_dir", message: check.error.message });
    // Detached and unreferenced: the engine keeps running when this client exits.
    const started = spawnDetached({ command: start.command, args: start.args, env: start.env ?? process.env, logPath });
    if (!started.ok) return err({ code: "start_failed", message: started.error.message });
    const child = started.value;
    this.child = child;
    child.once("error", (error) => (this.startError = `cannot start the engine: ${error.message}`));
    child.once("exit", (code, signal) => {
      // An engine that lost a start race exits with code 3; the client connects to the winner.
      if (this.child !== child || code === EXIT_ALREADY_RUNNING) return;
      const how = code === null ? `by signal ${signal}` : `with code ${code}`;
      this.startError = `the engine exited ${how} before it accepted a connection; see ${logPath}`;
    });
    return ok(undefined);
  }

  private onLine(line: string): void {
    const parsedLine = parseJsonLine(line);
    const json = parsedLine.ok ? parsedLine.value : undefined;
    const message = parseServerMessage(json);
    if (!message.ok) {
      // A connection error ends the connection; the close that follows triggers the reconnect.
      if (parseHandshakeReply(json).ok) return;
      // An event type a newer engine added is skipped; anything else unreadable ends the connection.
      if (isUnknownEvent(json)) return;
      this.socket?.destroy();
      return;
    }
    if (message.value.kind === "reply") {
      this.pending.get(message.value.requestId)?.(message.value.result);
      return;
    }
    this.publish({ kind: "event", seq: message.value.seq, event: message.value.event });
  }

  private onClose(): void {
    this.socket = undefined;
    this.failPending("disconnected", "the connection to the engine was lost");
    if (this.closing) return;
    this.publish({ kind: "disconnected" });
    if (this.options.reconnect === false) return this.fail({ code: "not_running", message: "the connection to the engine was lost" });
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    let delay = 50;
    while (!this.closing) {
      await this.sleep(delay);
      if (this.closing) return;
      const attempt = await this.attempt(this.limitMs);
      if (attempt.ok) return this.publish({ kind: "reconnected", engineId: this.engineId });
      if (TERMINAL.has(attempt.error.code)) return this.fail(attempt.error);
      delay = Math.min(delay * 2, 1_000);
    }
  }

  private fail(error: ConnectError): void {
    this.publish({ kind: "failed", error });
    this.closing = true;
    this.endSubscribers();
  }

  private publish(event: ClientEvent): void {
    for (const subscriber of this.subscribers) subscriber.push(event);
  }

  private endSubscribers(): void {
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
  }

  private failPending(code: string, message: string): void {
    for (const resolve of [...this.pending.values()]) resolve(failure(code, message));
  }

  /** Sleeps, but wakes early when the client closes. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeups.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeups.add(done);
    });
  }
}

/** A socket and the token that belongs to it. */
export interface SocketFiles {
  readonly socketPath: string;
  readonly tokenPath: string;
}

/**
 * Why a connection did not come to a welcome, beyond the error code: `dead` (nothing listens, or
 * its files are gone), `closed` (the engine closed the connection without a reply: it is
 * stopping), `silent` (it accepted and did not answer in time).
 */
interface SessionFailure extends ConnectError {
  readonly reason?: "dead" | "closed" | "silent" | "no_token";
}

/**
 * The token of a socket, read only from a folder that is ours and private, as the engine made it.
 * A folder or token that is missing means the engine is gone; a folder that is not ours is refused.
 */
function readToken(files: SocketFiles): Result<string, SessionFailure> {
  const dir = checkEngineDir(dirname(files.socketPath));
  if (!dir.ok) return err(dir.error.code === "missing" ? { code: "not_running", message: dir.error.message, reason: "dead" } : { code: "unsafe_dir", message: dir.error.message });
  try {
    // Read on every attempt: the token changes each time the engine starts.
    return ok(readFileSync(files.tokenPath, "utf8").trim());
  } catch {
    return err({ code: "not_running", message: `no engine token at ${files.tokenPath}`, reason: "no_token" });
  }
}

/** Connects and handshakes. The handlers get every line after the welcome, and the close. */
function openSession(files: SocketFiles, timeoutMs: number, handlers: SessionHandlers): Promise<Result<Session, SessionFailure>> {
  return new Promise((resolve) => {
    const read = readToken(files);
    if (!read.ok) {
      resolve(read);
      return;
    }
    const token = read.value;
    const socket = connectSocket(files.socketPath);
    const decoder = new LineDecoder();
    let session: Session | undefined;
    let settled = false;
    let accepted = false;
    const settle = (result: Result<Session, SessionFailure>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok) socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle(err({ code: "timeout", message: `no welcome within ${timeoutMs} ms`, ...(accepted && { reason: "silent" as const }) })), timeoutMs);

    socket.once("connect", () => {
      accepted = true;
      const hello = encodeLine({ kind: "hello", apiVersion: API_VERSION, token });
      if (hello.ok) socket.write(hello.value);
    });
    socket.on("error", (error) => {
      // Refused, or no such socket: the engine is gone.
      const dead = hasCode(error, "ECONNREFUSED") || hasCode(error, "ENOENT");
      settle(err({ code: "not_running", message: `cannot reach the engine: ${error.message}`, ...(dead && { reason: "dead" as const }) }));
    });
    socket.on("close", () => {
      if (session) handlers.onClose();
      else settle(err({ code: "not_running", message: "the engine closed the connection", ...(accepted && { reason: "closed" as const }) }));
    });
    socket.on("data", (chunk: Buffer) => {
      const lines = decoder.push(chunk);
      if (!lines.ok) {
        settle(err({ code: "protocol_error", message: "the engine sent a message over the size limit" }));
        socket.destroy();
        return;
      }
      for (const line of lines.value) {
        if (session) {
          handlers.onLine(line);
          continue;
        }
        const json = parseJsonLine(line);
        const reply = parseHandshakeReply(json.ok ? json.value : undefined);
        if (!reply.ok) return settle(err({ code: "protocol_error", message: "the engine did not answer the hello" }));
        const engine: EngineInfo = {
          apiVersion: reply.value.apiVersion,
          ...(reply.value.engineVersion !== undefined && { engineVersion: reply.value.engineVersion }),
          ...(reply.value.runningItems !== undefined && { runningItems: reply.value.runningItems }),
        };
        if (reply.value.kind === "connection_error") {
          const code = handshakeCode(reply.value.code);
          return settle(err({ code, message: reply.value.message, ...(code === "unsupported_version" && { engine }) }));
        }
        if (reply.value.apiVersion !== API_VERSION) {
          return settle(err({ code: "unsupported_version", message: `engine speaks API version ${reply.value.apiVersion}`, engine }));
        }
        session = { socket, engineId: reply.value.engineId, engine };
        settle(ok(session));
      }
    });
  });
}

/**
 * The engine's answer to a shutdown request: it accepted and stops, it refused because items run
 * (`ifIdle` only; `runningItems` is absent when it could not count them), or there was no usable
 * answer (an engine older than the request, a wrong token, silence, no engine).
 */
export type ShutdownAnswer =
  /** `engineId` and `pid` say which engine answered; an engine older than the lock rewrite does not send them. */
  | { readonly kind: "accepted"; readonly engineId?: string; readonly pid?: number }
  | { readonly kind: "refused"; readonly runningItems?: number; readonly engineId?: string; readonly pid?: number }
  | { readonly kind: "none" };

/**
 * Asks the engine on a socket to stop, with the token next to it, in place of a hello. Every
 * engine from the version that added the request accepts it, whatever its API version. `ifIdle`
 * is understood only from API version SHUTDOWN_IF_IDLE_SINCE on: an older engine ignores it and
 * stops at once.
 */
export function sendShutdown(files: SocketFiles, options: { readonly ifIdle?: boolean; readonly timeoutMs?: number } = {}): Promise<ShutdownAnswer> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const none: ShutdownAnswer = { kind: "none" };
  return new Promise((resolve) => {
    // The token goes only into a directory that is ours and private, as for a hello.
    const read = readToken(files);
    if (!read.ok) return resolve(none);
    const token = read.value;
    const socket = connectSocket(files.socketPath);
    const decoder = new LineDecoder();
    let settled = false;
    const settle = (answer: ShutdownAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => settle(none), timeoutMs);
    socket.once("connect", () => {
      const request = encodeLine({ kind: "shutdown", apiVersion: API_VERSION, token, ...(options.ifIdle === true && { ifIdle: true }) });
      if (request.ok) socket.write(request.value);
      else settle(none);
    });
    socket.on("error", () => settle(none));
    socket.on("close", () => settle(none));
    socket.on("data", (chunk: Buffer) => {
      const lines = decoder.push(chunk);
      if (!lines.ok) return settle(none);
      const first = lines.value[0];
      if (first === undefined) return;
      const json = parseJsonLine(first);
      const reply = parseShutdownReply(json.ok ? json.value : undefined);
      if (!reply.ok) return settle(none);
      const who = { ...(reply.value.kind !== "connection_error" && reply.value.engineId !== undefined && { engineId: reply.value.engineId }), ...(reply.value.kind !== "connection_error" && reply.value.pid !== undefined && { pid: reply.value.pid }) };
      if (reply.value.kind === "shutdown_accepted") return settle({ kind: "accepted", ...who });
      if (reply.value.kind === "shutdown_refused") return settle({ kind: "refused", ...(reply.value.runningItems !== undefined && { runningItems: reply.value.runningItems }), ...who });
      settle(none);
    });
  });
}

/**
 * Asks the engine on a socket to stop. True when the engine accepted; false when it refused (an
 * engine older than the request), did not answer within `timeoutMs`, or is not there.
 */
export async function requestShutdown(files: SocketFiles, timeoutMs = 2_000): Promise<boolean> {
  return (await sendShutdown(files, { timeoutMs })).kind === "accepted";
}

function handshakeCode(code: string): ConnectErrorCode {
  if (code === "unauthorized" || code === "unsupported_version") return code;
  return "protocol_error";
}

function failure(code: string, message: string): RequestResult {
  return { ok: false, error: { code, message } };
}

