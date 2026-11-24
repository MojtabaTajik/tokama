// Typed client of the engine API over the local socket.
//
// connect() reads the per-session token, sends a hello and waits for the welcome. When the engine
// is not running and a start command is given, it starts the engine (detached, so it outlives
// the client) and keeps trying until the start timeout. After a lost connection the client
// reconnects on its own (starting the engine again when it can) and emits `reconnected`: the
// engine may have restarted and `seq` restarted with it, so the consumer re-runs its queries.
// Requests in flight when the connection drops fail with `disconnected`; they are never resent,
// because commands are not idempotent.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect as connectSocket, type Socket } from "node:net";
import { homedir } from "node:os";
import {
  API_VERSION,
  type ClientMessageInput,
  type CommandInput,
  defaultEngineDir,
  encodeLine,
  type EngineEndpoint,
  engineEndpoint,
  type EngineEvent,
  err,
  LineDecoder,
  ok,
  parseClientMessage,
  parseHandshakeReply,
  parseServerMessage,
  type QueryInput,
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
  /** Engine directory. Default: `defaultEngineDir()` (TOKAMA_ENGINE_DIR, XDG_RUNTIME_DIR or ~/.tokama/run). */
  readonly dir?: string;
  /** How to start the engine when it is not running. Without it, the client never starts one. */
  readonly start?: EngineCommand;
  /** How long connect() waits for a started engine. Default 10 s. */
  readonly startTimeoutMs?: number;
  /** Default timeout of one request. Default 30 s. */
  readonly requestTimeoutMs?: number;
  /** Reconnect after a lost connection. Default true. */
  readonly reconnect?: boolean;
}

export type ConnectErrorCode =
  | "invalid_endpoint"
  | "not_running"
  | "start_failed"
  | "timeout"
  | "unauthorized"
  | "unsupported_version"
  | "protocol_error";

export interface ConnectError {
  readonly code: ConnectErrorCode;
  readonly message: string;
}

/** A reply's result: `data` on success, or an error code such as `not_found`, `not_implemented`, `disconnected`, `timeout`. */
export type RequestResult = ReplyMessage["result"];

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
  query(query: QueryInput, options?: RequestOptions): Promise<RequestResult>;
  command(command: CommandInput, options?: RequestOptions): Promise<RequestResult>;
  /** Events from the time of this call on. The iteration ends when the client closes or fails. */
  events(): AsyncIterable<ClientEvent>;
  close(): Promise<void>;
}

const TERMINAL: ReadonlySet<ConnectErrorCode> = new Set(["unauthorized", "unsupported_version", "protocol_error", "start_failed"]);
const ATTEMPT_TIMEOUT_MS = 2_000;
const RESTART_INTERVAL_MS = 2_000;

export async function connect(options: ConnectOptions = {}): Promise<Result<EngineClient, ConnectError>> {
  const endpoint = engineEndpoint(options.dir ?? defaultEngineDir(process.env, homedir()));
  if (!endpoint.ok) return err({ code: "invalid_endpoint", message: endpoint.error.message });
  const client = new Client(endpoint.value, options);
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
}

interface Subscriber {
  push(event: ClientEvent): void;
  end(): void;
}

class Client implements EngineClient {
  engineId = "";
  private socket: Socket | undefined;
  private readonly pending = new Map<string, (result: RequestResult) => void>();
  private readonly subscribers = new Set<Subscriber>();
  private closing = false;
  private nextRequest = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private startError: Error | undefined;
  private readonly wakeups = new Set<() => void>();

  constructor(
    private readonly endpoint: EngineEndpoint,
    private readonly options: ConnectOptions,
  ) {}

  /** First connection: start the engine if needed and wait for it. */
  async open(): Promise<Result<void, ConnectError>> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 10_000);
    for (;;) {
      const attempt = await this.attempt();
      if (attempt.ok || TERMINAL.has(attempt.error.code)) return attempt;
      if (!this.options.start) return attempt;
      if (Date.now() >= deadline) return err({ code: "timeout", message: `the engine did not start: ${attempt.error.message}` });
      await this.sleep(50);
    }
  }

  query(query: QueryInput, options?: RequestOptions): Promise<RequestResult> {
    return this.request({ apiVersion: API_VERSION, kind: "query", requestId: this.requestId(), query }, options);
  }

  command(command: CommandInput, options?: RequestOptions): Promise<RequestResult> {
    return this.request({ apiVersion: API_VERSION, kind: "command", requestId: this.requestId(), command }, options);
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

  /** One connection attempt; starts the engine (at most every few seconds) when it is not running. */
  private async attempt(): Promise<Result<void, ConnectError>> {
    if (this.startError) return err({ code: "start_failed", message: `cannot start the engine: ${this.startError.message}` });
    const session = await openSession(this.endpoint, ATTEMPT_TIMEOUT_MS, {
      onLine: (line) => this.onLine(line),
      onClose: () => this.onClose(),
    });
    if (session.ok) {
      if (this.closing) {
        session.value.socket.destroy();
        return err({ code: "not_running", message: "the client was closed" });
      }
      this.socket = session.value.socket;
      this.engineId = session.value.engineId;
      return ok(undefined);
    }
    if (session.error.code === "not_running" && this.options.start && Date.now() - this.lastStart >= RESTART_INTERVAL_MS) {
      this.lastStart = Date.now();
      this.startEngine(this.options.start);
    }
    return session;
  }

  private startEngine(start: EngineCommand): void {
    // Detached and unreferenced: the engine keeps running when this client exits. An engine that
    // loses a start race to another one exits on its own; the client then connects to the winner.
    const child = spawn(start.command, [...start.args], { detached: true, stdio: "ignore", env: start.env ?? process.env });
    child.once("error", (error) => (this.startError = error));
    child.unref();
  }

  private onLine(line: string): void {
    const json = parseJson(line);
    const message = parseServerMessage(json);
    if (!message.ok) {
      // A connection error ends the connection; the close that follows triggers the reconnect.
      if (parseHandshakeReply(json).ok) return;
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
      const attempt = await this.attempt();
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

/** Connects and handshakes. The handlers get every line after the welcome, and the close. */
function openSession(endpoint: EngineEndpoint, timeoutMs: number, handlers: SessionHandlers): Promise<Result<Session, ConnectError>> {
  return new Promise((resolve) => {
    let token: string;
    try {
      // Read on every attempt: the token changes each time the engine starts.
      token = readFileSync(endpoint.tokenPath, "utf8").trim();
    } catch {
      resolve(err({ code: "not_running", message: `no engine token at ${endpoint.tokenPath}` }));
      return;
    }
    const socket = connectSocket(endpoint.socketPath);
    const decoder = new LineDecoder();
    let session: Session | undefined;
    let settled = false;
    const settle = (result: Result<Session, ConnectError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok) socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle(err({ code: "timeout", message: `no welcome within ${timeoutMs} ms` })), timeoutMs);

    socket.once("connect", () => {
      const hello = encodeLine({ kind: "hello", apiVersion: API_VERSION, token });
      if (hello.ok) socket.write(hello.value);
    });
    socket.on("error", (error) => settle(err({ code: "not_running", message: `cannot reach the engine: ${error.message}` })));
    socket.on("close", () => {
      if (session) handlers.onClose();
      else settle(err({ code: "not_running", message: "the engine closed the connection" }));
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
        const reply = parseHandshakeReply(parseJson(line));
        if (!reply.ok) return settle(err({ code: "protocol_error", message: "the engine did not answer the hello" }));
        if (reply.value.kind === "connection_error") return settle(err({ code: handshakeCode(reply.value.code), message: reply.value.message }));
        if (reply.value.apiVersion !== API_VERSION) {
          return settle(err({ code: "unsupported_version", message: `engine speaks API version ${reply.value.apiVersion}` }));
        }
        session = { socket, engineId: reply.value.engineId };
        settle(ok(session));
      }
    });
  });
}

function handshakeCode(code: string): ConnectErrorCode {
  if (code === "unauthorized" || code === "unsupported_version") return code;
  return "protocol_error";
}

function failure(code: string, message: string): RequestResult {
  return { ok: false, error: { code, message } };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
