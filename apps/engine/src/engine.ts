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
  addRepo,
  type AddRepoResult,
  API_VERSION,
  type BoardResult,
  checkEngineDir,
  type Clock,
  type CommandErrorCode,
  type ConnectionErrorCode,
  type ClientMessage,
  type Command,
  createGit,
  createProcessRunner,
  encodeLine,
  type EngineEvent,
  formatProblem,
  type Git,
  type EngineEndpoint,
  engineEndpoint,
  err,
  type ItemResult,
  LineDecoder,
  loadRepos,
  MAX_MESSAGE_BYTES,
  ok,
  parseClientMessage,
  parseHelloMessage,
  type ParseError,
  removeRepo,
  type Result,
  suggestRepo,
  type SuggestRepoResult,
  type SuggestTemplateResult,
  systemClock,
  type SetupResult,
  ItemStore,
  loadHostId,
  posixProcessTable,
  type ProcessTable,
  type StoredItem,
  type Agent,
  type AgentRuntime,
  type ProcessRunner,
} from "@tokama/core";
import { ItemIndex } from "./item-index.js";
import { type HealthChecks, machineChecks } from "./real/health.js";
import { RealEngine } from "./real/real.js";
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
   * Tokama's home folder (`~/.tokama`): item logs in `items/`, the board index in `tokama.db`, and
   * `repos.yaml`. Without it nothing is stored; in sample mode only repos.yaml is.
   */
  readonly home?: string;
  /** Read and signal leftover agent processes on start. Default: the POSIX process table. */
  readonly processTable?: ProcessTable;
  /** Real mode: runs git, setup and check commands and the AI CLIs. Default: a new process runner. */
  readonly runner?: ProcessRunner;
  /** Real mode: the runtime for an agent. Default: Claude Code for claude-code agents. */
  readonly runtime?: (agent: Agent) => AgentRuntime | undefined;
  /** Real mode: the startup checks. Default: git's version and Claude Code's login, on this machine. */
  readonly checks?: HealthChecks;
  /** Real mode: time between SIGTERM and SIGKILL for a leftover agent tree at start. */
  readonly recoveryGraceMs?: number;
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
  /** `stopped`: the signal aborted or close() was called before the start finished. */
  readonly code: "already_running" | "invalid_endpoint" | "unsafe_dir" | "start_failed" | "stopped";
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

  // The item store has one writer: the engine that holds the home folder's own lock. Engines with
  // different engine dirs can share a home, so the engine dir's lock does not cover it.
  let storage: Storage | undefined;
  const homeLock = options.home !== undefined && !options.sample ? { lockPath: join(options.home, "engine.lock"), socketPath, dir: options.home } : undefined;
  const homeLockContent = `${process.pid} ${engineId} ${socketPath}\n`;
  if (homeLock !== undefined) {
    const home = homeLock.dir;
    const opened = await (async (): Promise<Result<Storage, StartError>> => {
      try {
        mkdirSync(home, { recursive: true, mode: 0o700 });
      } catch (error) {
        return err({ code: "start_failed", message: `cannot create ${home}: ${String(error)}` });
      }
      const locked = await acquireLock(homeLock, homeLockContent, log);
      if (!locked.ok) return locked;
      const result = await openStorage(home, options.clock ?? systemClock, log);
      if (!result.ok) releaseLock(homeLock.lockPath, homeLockContent);
      return result;
    })();
    if (!opened.ok) {
      releaseLock(lockPath, lockContent);
      return opened;
    }
    storage = opened.value;
  }
  const releaseStorage = () => {
    storage?.close();
    if (homeLock !== undefined) releaseLock(homeLock.lockPath, homeLockContent);
  };

  // From here on the lock is ours, so the socket and token files at these paths are ours too.
  let server: Server;
  let token: Buffer;
  try {
    unlinkIfPresent(socketPath);
    token = writeToken(tokenPath);
    server = await listen(socketPath);
    chmodSync(socketPath, 0o600);
  } catch (error) {
    releaseStorage();
    unlinkIfPresent(socketPath);
    unlinkIfPresent(tokenPath);
    releaseLock(lockPath, lockContent);
    return err({ code: "start_failed", message: `could not listen on ${socketPath}: ${String(error)}` });
  }

  const store = options.store ?? new MemoryItemStore();
  const sample = options.sample ? new SampleEngine(store, options.clock ?? systemClock) : undefined;
  const runner = options.runner ?? createProcessRunner();
  // Real mode: the engine stores items. Its run loop starts restart recovery at once.
  const realEngine: Promise<RealEngine | undefined> =
    storage === undefined || options.home === undefined
      ? Promise.resolve(undefined)
      : RealEngine.create({
          home: options.home,
          items: storage.items,
          store,
          clock: options.clock ?? systemClock,
          processes: options.processTable ?? posixProcessTable,
          runner,
          checks: options.checks ?? machineChecks(runner),
          ...(options.runtime !== undefined && { runtime: options.runtime }),
          ...(options.recoveryGraceMs !== undefined && { recoveryGraceMs: options.recoveryGraceMs }),
          log,
        }).catch((error: unknown) => {
          log(`real mode failed to start: ${String(error)}`);
          return undefined;
        });
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

  // repos.yaml changes one at a time, so two adds cannot both read the file before either writes.
  let git: Git | undefined;
  let repoChanges: Promise<unknown> = Promise.resolve();
  // In sample mode the sample repos keep their ids: a repos.yaml repo can't take one.
  const sampleRepoIds = sample?.setup.repos.map((repo) => repo.id) ?? [];
  const repoOptions = (tokamaHome: string) => ({ tokamaHome, git: (git ??= createGit({ runner: createProcessRunner() })), reservedIds: sampleRepoIds });

  const repoCommand = async (command: Extract<Command, { type: "add_repo" | "remove_repo" }>): Promise<ReplyResult> => {
    const home = options.home;
    if (home === undefined) return { ok: false, error: { code: "not_implemented" satisfies CommandErrorCode, message: "this engine has no Tokama home folder for repos.yaml" } };
    if (command.type === "remove_repo" && sampleRepoIds.includes(command.repoId)) {
      return { ok: false, error: { code: "not_found" satisfies CommandErrorCode, message: `${command.repoId} is a sample repo; it isn't in repos.yaml, so it can't be removed.` } };
    }
    const change = repoChanges.then(() =>
      command.type === "add_repo"
        ? addRepo(repoOptions(home), {
            path: command.path,
            ...(command.id === undefined ? {} : { id: command.id }),
            ...(command.baseBranch === undefined ? {} : { baseBranch: command.baseBranch }),
            ...(command.checks === undefined ? {} : { checks: command.checks }),
          })
        : removeRepo(repoOptions(home), command.repoId),
    );
    repoChanges = change.catch(() => undefined);
    const result = await change;
    if (!result.ok) return { ok: false, error: result.error };
    // Real mode reads the repos again, so the run loop sees the change at once.
    await (await realEngine)?.refresh();
    broadcast({ type: "setup_changed" });
    log(`${command.type === "add_repo" ? "added" : "removed"} repo ${result.value.id}`);
    return { ok: true, data: command.type === "add_repo" ? ({ repo: { id: result.value.id, baseBranch: result.value.baseBranch, checks: [...result.value.checks] } } satisfies AddRepoResult) : null };
  };

  /** The sample setup in sample mode, with the repos of repos.yaml after its own. */
  const setup = async (): Promise<SetupResult> => {
    const base: SetupResult = sample ? { ...sample.setup, repos: sample.setup.repos.map((repo) => ({ ...repo, sample: true as const })) } : { repos: [], connections: [], agents: [], templates: [], health: { git: { ok: true }, clis: [], config: [] } };
    if (options.home === undefined) return base;
    const loaded = await loadRepos({ tokamaHome: options.home });
    if (!loaded.ok) {
      log(`repos.yaml is not loaded: ${loaded.error.problems.map(formatProblem).join("; ")}`);
      return base;
    }
    const added = loaded.value.filter((repo) => !base.repos.some((known) => known.id === repo.id));
    return { ...base, repos: [...base.repos, ...added.map((repo) => ({ id: repo.id, baseBranch: repo.baseBranch, checks: [...repo.checks] }))] };
  };

  const dispatch = async (message: ClientMessage): Promise<ReplyResult> => {
    // Real mode answers once its config is read and its items are projected into the store.
    const real = await realEngine;
    if (real !== undefined) {
      if (message.kind === "command") {
        const { command } = message;
        if (command.type !== "add_repo" && command.type !== "remove_repo") {
          const result = await real.command(command);
          return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
        }
      } else if (message.query.type === "setup") {
        return { ok: true, data: (await real.setup()) satisfies SetupResult };
      } else if (message.query.type === "suggest_template") { return { ok: true, data: { templateId: await real.suggestTemplate() } as SuggestTemplateResult };
      }
    }
    if (message.kind === "command") {
      const command = message.command;
      if (command.type === "add_repo" || command.type === "remove_repo") return repoCommand(command);
      if (!sample) {
        const code: CommandErrorCode = "not_implemented";
        return { ok: false, error: { code, message: `command "${message.command.type}" is not implemented yet` } };
      }
      const result = sample.command(command);
      return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
    }
    const query = message.query;
    switch (query.type) {
      case "setup":
        return { ok: true, data: await setup() };
      case "board":
        return { ok: true, data: { items: store.list() } satisfies BoardResult };
      case "item": {
        const item = store.get(query.itemId);
        return item ? { ok: true, data: { item } satisfies ItemResult } : { ok: false, error: { code: "not_found", message: `no item ${query.itemId}` } };
      }
      case "suggest_template":
        return { ok: true, data: { templateId: sample?.suggestTemplate(query.text) ?? null } satisfies SuggestTemplateResult };
      case "suggest_repo": {
        if (options.home === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine has no Tokama home folder for repos.yaml" } };
        const suggested = await suggestRepo(repoOptions(options.home), query.path);
        if (!suggested.ok) return { ok: false, error: suggested.error };
        const { path, gitRepo, branch, id, checks, problem } = suggested.value;
        return { ok: true, data: { path, gitRepo, branch: branch ?? null, id: id ?? null, checks: [...checks], problem: problem ?? null } satisfies SuggestRepoResult };
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
  function broadcast(event: EngineEvent): void {
    const line = encodeLine({ apiVersion: API_VERSION, kind: "event", seq: seq++, event });
    if (!line.ok) return log(`dropped an event larger than ${MAX_MESSAGE_BYTES} bytes`);
    for (const socket of ready) write(socket, line.value);
  }
  const unsubscribe = store.subscribe((item) => broadcast({ type: "item_updated", item }));

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
    // The run loop writes to the item logs; it must be done before another engine may open them.
    await (await realEngine)?.close().catch((error: unknown) => log(`closing the run loop failed: ${String(error)}`));
    // Closing the server removes the socket file. Only then may another engine take over.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    releaseStorage();
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

  // Recovery can take seconds (a grace period per leftover tree). It runs once the socket answers,
  // so an engine starting meanwhile sees this one as live rather than its lock as stale.
  const real = await realEngine;
  if (real !== undefined && !shuttingDown) {
    for (const recovered of await real.ready.catch((error: unknown) => (log(`restart recovery failed: ${String(error)}`), []))) {
      const kills = recovered.kills.map(({ pid, outcome }) => `${pid} ${outcome.kind}${"reason" in outcome ? ` (${outcome.reason})` : ""}${"message" in outcome ? ` (${outcome.message})` : ""}`);
      log(`item ${recovered.itemId}: step ${recovered.stepId} was running; asking retry or stop${kills.length > 0 ? `; processes: ${kills.join(", ")}` : ""}${recovered.error ? `; not recorded: ${recovered.error.message}` : ""}`);
    }
  }
  if (shuttingDown) {
    await closed;
    return err({ code: "stopped", message: "the engine was stopped while it started" });
  }

  log(`listening on ${socketPath} (engine ${engineId}${sample ? ", sample data" : ""})`);
  return ok({ engineId, endpoint: endpoint.value, store, ...(storage && { items: storage.items }), closed, close: shutdown });
}

interface Storage {
  readonly items: ItemStore;
  close(): void;
}

/** Loads the item logs and rebuilds the board index from them. The index follows every change after that. */
async function openStorage(home: string, clock: Clock, log: (message: string) => void): Promise<Result<Storage, StartError>> {
  let index: ItemIndex | undefined;
  try {
    const hostId = loadHostId(home, clock);
    if (!hostId.ok) return err({ code: "start_failed", message: hostId.error });
    const { store: items, problems } = ItemStore.open({ home, hostId: hostId.value, clock });
    for (const problem of problems) log(`item ${problem.itemId} is not loaded: ${problem.message}`);
    index = openIndex(join(home, "tokama.db"), items.list(), clock, log);
    const opened = index;
    const unsubscribe = items.subscribe((item) => {
      // The event is on disk already; a failed index write must not fail the append.
      try {
        opened.put(item);
      } catch (error) {
        log(`cannot update the board index for ${item.id}: ${String(error)}`);
      }
    });
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

/**
 * Opens the board index and rebuilds it from the logs. A database that cannot be opened or
 * rebuilt is moved aside with its -wal and -shm files (it holds only derived data) and made anew.
 */
function openIndex(file: string, items: readonly StoredItem[], clock: Clock, log: (message: string) => void): ItemIndex {
  try {
    const index = ItemIndex.open(file);
    try {
      index.rebuild(items);
      return index;
    } catch (error) {
      index.close();
      throw error;
    }
  } catch (error) {
    const aside = `${file}.damaged-${clock.now()}`;
    log(`the board index ${file} is damaged (${String(error)}); moving it to ${aside} and rebuilding it`);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        renameSync(`${file}${suffix}`, `${aside}${suffix}`);
      } catch (moveError) {
        if (!hasCode(moveError, "ENOENT")) throw moveError;
      }
    }
    const index = ItemIndex.open(file);
    index.rebuild(items);
    return index;
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

/** A lock file, the socket of the engine that holds it, and the folder named in messages. */
type LockSpec = Pick<EngineEndpoint, "lockPath" | "socketPath" | "dir">;

async function acquireLock(endpoint: LockSpec, content: string, log: (message: string) => void): Promise<Result<void, StartError>> {
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
    const live = await lockIsLive(endpoint);
    if (live.live) return err({ code: "already_running", message: `an engine is already running on ${live.socketPath}` });
    log(`removing a stale lock in ${endpoint.dir}`);
    unlinkIfPresent(endpoint.lockPath);
  }
  return err({ code: "already_running", message: `another engine is starting in ${endpoint.dir}` });
}

/**
 * A lock whose third field names a socket (the home lock) is probed on that socket; the engine
 * dir's lock is probed on the dir's socket.
 */
async function lockIsLive(endpoint: LockSpec): Promise<{ live: boolean; socketPath: string }> {
  let content: string;
  let ageMs: number;
  try {
    content = readFileSync(endpoint.lockPath, "utf8");
    ageMs = Date.now() - lstatSync(endpoint.lockPath).mtimeMs;
  } catch {
    return { live: await socketAnswers(endpoint.socketPath), socketPath: endpoint.socketPath };
  }
  const [pidField, , socketField] = content.trim().split(" ");
  const socketPath = socketField || endpoint.socketPath;
  if (await socketAnswers(socketPath)) return { live: true, socketPath };
  const pid = Number.parseInt(pidField ?? "", 10);
  if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return { live: false, socketPath };
  return { live: ageMs < STARTING_GRACE_MS, socketPath };
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
