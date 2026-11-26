// The engine service: serves the engine API on a user-owned Unix domain socket.
//
// Start order: a 0700 directory owned by the user, then the single-instance lock, then a new
// per-session token (0600 file), then the socket (0600). Each connection starts with a hello
// carrying the token and the client's API version; after the welcome, the client sends commands
// and queries (one JSON message per line) and receives replies and events.
//
// A connection may start with a shutdown request (with the token) in place of the hello: a newer
// app sends it to replace this engine, whatever its API version.
//
// Shutdown, when the signal aborts, close() is called or a client asks for it: refuse new connections, wait for
// in-flight requests (bounded), close the connections, stop listening, then remove the socket,
// token and lock files if the lock is still this engine's. The socket keeps answering until the
// drain ends, so an engine starting meanwhile sees a live engine instead of a stale lock.
// Threat model: local desktop, no network listener.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
// eslint-disable-next-line no-restricted-imports -- the engine lock is created exclusively (O_EXCL), which is the lock itself; renameSync moves a damaged board index aside.
import { renameSync, writeSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  addRepo,
  type AddRepoResult,
  type UpdateRepoResult,
  type AgentsListResult,
  type AiClisResult,
  API_VERSION,
  type BoardResult,
  type ItemListResult,
  type ItemRecord,
  checkEngineDir,
  displayPath,
  hasCode,
  parseJsonLine,
  withDeadline,
  type Clock,
  type CommandErrorCode,
  type ConnectionErrorCode,
  type DecisionDiffResult,
  type StepOutputResult,
  type AttemptChecksResult,
  type AttemptFileResult,
  type AttemptLogResult,
  type ClientMessage,
  type Command,
  createGit,
  createMachineSource,
  createMonitor,
  createProcessRunner,
  encodeLine,
  type EngineEvent,
  formatProblem,
  type Git,
  type EngineEndpoint,
  engineEndpoint,
  err,
  type ItemResult,
  type ActivityResult,
  type ItemActivity,
  LineDecoder,
  loadRepos,
  MAX_MESSAGE_BYTES,
  localDate,
  ok,
  parseClientMessage,
  parseOpeningMessage,
  type ParseError,
  pidAlive,
  posixEngineProcesses,
  readPidFile,
  replaceTextSync,
  removeRepo,
  type RepoEditError,
  type Result,
  suggestRepo,
  initRepo,
  makeFirstCommit,
  updateRepo,
  type SuggestRepoResult,
  type SuggestTemplateResult,
  systemClock,
  type MachineResult,
  type MachineSource,
  type UsageResult,
  type SetupResult,
  type TemplateDetailResult,
  type TemplatesResult,
  ItemStore,
  loadHostId,
  posixProcessTable,
  type ProcessTable,
  type StoredItem,
  type Agent,
  type AgentRuntime,
  type ProcessRunner,
  type MachineFacts,
} from "@tokama/core";
import { ActivityFeed } from "./activity-feed.js";
import { EngineDiagnostics, isDiagnosticsCommand } from "./diagnostics.js";
import { listAgents } from "./agents-list.js";
import { aiClis } from "./ai-clis.js";
import { ItemIndex } from "./item-index.js";
import { ItemList, nameHits } from "./item-list.js";
import { type HealthChecks, machineChecks } from "./real/health.js";
import { runningGroups } from "./machine.js";
import { RealEngine } from "./real/real.js";
import { SampleEngine } from "./sample/sample.js";
import { agentsFor, loadConfig, startProblem, stepProblems } from "./real/config.js";
import { sampleTemplateLoads } from "./sample/templates.js";
import { openSampleDiagnostics } from "./sample/diagnostics.js";
import { sampleMachineReport } from "./sample/machine.js";
import { sampleClaudePlan, sampleLogEntries, sampleOtherPlans, sampleUsageRows } from "./sample/usage.js";
import { ClaudeLogs } from "./claude-logs.js";
import { claudePlanSources, type PlanSources, UsageService } from "./usage.js";
import { MemoryItemStore } from "./store.js";
import { templateDetail, templateEntries, type TemplateFiles } from "./templates.js";

export interface EngineOptions {
  /** Directory for the socket, token and lock; created with mode 0700 if missing. */
  readonly dir: string;
  /** Aborting it shuts the engine down. */
  readonly signal?: AbortSignal;
  readonly store?: MemoryItemStore;
  /** Fake engine mode: serve the sample data set and handle commands on it (sample/sample.ts). */
  readonly sample?: boolean;
  /** Fake engine mode only: this many generated finished items over the last two months, for trying long lists. */
  readonly sampleHistory?: number;
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
  /**
   * Where plan windows come from. Default: Claude Code's usage request and its cached copy. Leave
   * out `request` to never start the CLI for them (it calls its vendor).
   */
  readonly planSources?: PlanSources;
  /** Where the machine query reads memory and processes. Default: this OS's source, none on an OS without one. */
  readonly machineSource?: MachineSource;
  /**
   * Real mode: Claude Code's projects folder (`~/.claude/projects`), whose session logs the `all`
   * usage scope reads. Absent: the logs are never read.
   */
  readonly claudeLogs?: string;
  /** Real mode: argv that starts gh for Open PR and its check. Default: `["gh"]`. */
  readonly ghCommand?: readonly [string, ...string[]];
  /** Default: the system clock. */
  readonly clock?: Clock;
  /** The version diagnostics entries carry. Default "0.0.0". */
  readonly engineVersion?: string;
  /** The user's home folder, cleaned from diagnostics as a path. Default: this process's home. */
  readonly userHome?: string;
  /** Machine facts for diagnostics entries. Default: read from this machine. */
  readonly machineFacts?: MachineFacts;
  /** Called once diagnostics are open, early in the start, so errors during the rest of it are recorded. */
  readonly onDiagnostics?: (diagnostics: EngineDiagnostics) => void;
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

// A lock that names no pid yet is still being written, unless it is older than this (its writer
// then died between creating and writing it).
const STARTING_GRACE_MS = 10_000;
// `ps` gives start times to the second, and on Linux they can be off by about a second more.
const START_TIME_SLACK_MS = 2_000;
const PROBE_TIMEOUT_MS = 1_000;
// A client that stops reading is disconnected once this much output is queued for it.
const MAX_QUEUED_BYTES = 8 * MAX_MESSAGE_BYTES;
/** The most bytes of item records one item_list reply holds, well under the message limit. */
const LIST_REPLY_BUDGET = MAX_MESSAGE_BYTES / 2;
// The folder that holds the engine and the packages it runs: the checkout in development. Stacks
// keep the built files below it (`<app>/apps/engine/dist/engine.js`).
const CODE_ROOT = resolve(import.meta.dirname, "..", "..", "..");

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
  let diagnostics: EngineDiagnostics | undefined;
  // Set once events can go out; the index calls it when it records new agent calls.
  let usageRecorded = () => {};
  // Set once events can go out; diagnostics call it when a crash is recorded or the settings change.
  let diagnosticsChanged = () => {};
  // Set once events can go out; diagnostics call it when entries are recorded or deleted.
  let entriesChanged = () => {};
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
      // Only the engine holding the home lock may read or clear the last engine's crash marker.
      diagnostics = await EngineDiagnostics.open({
        home,
        userHome: options.userHome ?? homedir(),
        codeRoots: [CODE_ROOT],
        engineVersion: options.engineVersion ?? "0.0.0",
        ...(options.machineFacts !== undefined && { machine: options.machineFacts }),
        clock: options.clock ?? systemClock,
        onChange: () => diagnosticsChanged(),
        onEntries: () => entriesChanged(),
        log,
      }).catch((error: unknown) => {
        log(`diagnostics are off for this run: ${String(error)}`);
        return undefined;
      });
      if (diagnostics !== undefined) options.onDiagnostics?.(diagnostics);
      const result = await openStorage(home, options.clock ?? systemClock, log, () => usageRecorded(), diagnostics);
      if (!result.ok) {
        diagnostics?.close();
        diagnostics = undefined;
        releaseLock(homeLock.lockPath, homeLockContent);
      }
      return result;
    })();
    if (!opened.ok) {
      releaseLock(lockPath, lockContent);
      return opened;
    }
    storage = opened.value;
  }
  if (options.sample) {
    // Under the engine dir's lock, which this engine holds; the Tokama home is never touched.
    diagnostics = await openSampleDiagnostics({
      dir: endpoint.value.dir,
      userHome: options.userHome ?? homedir(),
      codeRoots: [CODE_ROOT],
      engineVersion: options.engineVersion ?? "0.0.0",
      ...(options.machineFacts !== undefined && { machine: options.machineFacts }),
      clock: options.clock ?? systemClock,
      onChange: () => diagnosticsChanged(),
      onEntries: () => entriesChanged(),
      log,
    }).catch((error: unknown) => {
      log(`sample diagnostics are off for this run: ${String(error)}`);
      return undefined;
    });
  }
  const releaseStorage = () => {
    storage?.close();
    diagnostics?.close();
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
  // The work list's index follows the store from here on, so the sample's and real mode's items reach it.
  const list = ItemList.open();
  const putInList = (item: ItemRecord) => {
    try {
      list.put(item);
    } catch (error) {
      log(`cannot update the work list for ${item.id}: ${String(error)}`);
      diagnostics?.store.error("engine", "storage", error);
    }
  };
  // A store passed in may already hold items; one that cannot list leaves the list to its later puts.
  try {
    for (const item of store.list()) putInList(item);
  } catch (error) {
    log(`cannot fill the work list: ${String(error)}`);
  }
  const unfollowList = store.subscribe(putInList);
  // The last setup served: the work-list search matches template and agent names from it.
  let servedSetup: SetupResult | undefined;
  // What running items do now: pushed to every client, at most once a second per item, once the
  // event stream below exists (the sample items have their activity from the start).
  let pushActivity: (latest: ItemActivity) => void = () => {};
  const activity = new ActivityFeed(options.clock ?? systemClock, (latest) => pushActivity(latest));
  const sample = options.sample ? new SampleEngine(store, options.clock ?? systemClock, activity, options.sampleHistory) : undefined;
  const runner = options.runner ?? createProcessRunner();
  // Real mode: the engine stores items. Its run loop starts restart recovery at once. If it cannot
  // start, the engine still answers, and its setup says why nothing can run.
  let realFailure: string | undefined;
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
          checks: options.checks ?? machineChecks(runner, options.ghCommand),
          ...(options.runtime !== undefined && { runtime: options.runtime }),
          ...(options.recoveryGraceMs !== undefined && { recoveryGraceMs: options.recoveryGraceMs }),
          ...(options.ghCommand !== undefined && { ghCommand: options.ghCommand }),
          onActivity: (itemId, latest) => activity.update(itemId, latest),
          ...(diagnostics !== undefined && { onError: (error: unknown) => diagnostics?.store.error("engine", "storage", error) }),
          log,
        }).catch((error: unknown) => {
          realFailure = `Tokama could not start running items: ${String(error)}`.slice(0, 1000);
          log(realFailure);
          diagnostics?.store.error("engine", "startup", error);
          return undefined;
        });
  const clock = options.clock ?? systemClock;
  const usageChanged = () => broadcast({ type: "usage_changed" });
  // Stops a usage request in flight when the engine shuts down.
  const usageAbort = new AbortController();
  const index = storage?.index;
  const tokamaHome = options.home;
  const claudeLogs =
    index !== undefined && tokamaHome !== undefined && options.claudeLogs !== undefined
      ? new ClaudeLogs({
          index,
          root: options.claudeLogs,
          repos: async () => {
            const loaded = await loadRepos({ tokamaHome });
            return loaded.ok ? loaded.value : [];
          },
          clock,
          onChange: usageChanged,
          log,
          signal: usageAbort.signal,
        })
      : undefined;
  const usage = new UsageService(
    sample
      ? {
          rows: () => sampleUsageRows(sample.setup, store.list(), clock.now()),
          sources: { request: async () => ({ ok: true, value: sampleClaudePlan(clock.now()) }) },
          otherClis: sampleOtherPlans,
          logs: {
            refresh: () => {},
            status: () => ({ state: "ready", filesDone: 412, filesTotal: 412, asOf: clock.now() - 40_000 }),
            entries: () => sampleLogEntries(sample.setup, clock.now()),
            coveredFrom: () => 0,
          },
          clock,
          onChange: usageChanged,
        }
      : {
          rows: (since) => index?.usageRows(since) ?? [],
          ...(index !== undefined && { samples: { get: (cliId) => index.planSample(cliId), save: (cliId, reading) => index.savePlanSample(cliId, reading) } }),
          sources: options.planSources ?? claudePlanSources(usageAbort.signal),
          ...(claudeLogs !== undefined && { logs: claudeLogs }),
          clock,
          onChange: usageChanged,
          log,
        },
  );
  // Reads the machine only while a client asks. Sample mode serves sample readings instead.
  const machineSource = options.machineSource ?? createMachineSource(runner);
  const items = storage?.items;
  const machine =
    sample !== undefined || machineSource === undefined
      ? undefined
      : createMonitor({ source: machineSource, groups: () => (items === undefined ? [] : runningGroups(items)), clock, log });
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
  const fail = (socket: Socket, code: ConnectionErrorCode, message: string, extra: { runningItems?: number } = {}) => {
    ready.delete(socket);
    const line = encodeLine({ kind: "connection_error", apiVersion: API_VERSION, code, message, ...extra });
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

  const isRepoCommand = (command: Command): command is Extract<Command, { type: "add_repo" | "init_repo" | "first_commit" | "update_repo" | "remove_repo" }> =>
    command.type === "add_repo" || command.type === "init_repo" || command.type === "first_commit" || command.type === "update_repo" || command.type === "remove_repo";

  const repoCommand = async (command: Extract<Command, { type: "add_repo" | "init_repo" | "first_commit" | "update_repo" | "remove_repo" }>): Promise<ReplyResult> => {
    const home = options.home;
    if (home === undefined) return { ok: false, error: { code: "not_implemented" satisfies CommandErrorCode, message: "this engine has no Tokama home folder for repos.yaml" } };
    if ((command.type === "update_repo" || command.type === "remove_repo") && sampleRepoIds.includes(command.repoId)) {
      const verb = command.type === "remove_repo" ? "removed" : "edited";
      return { ok: false, error: { code: "not_found" satisfies CommandErrorCode, message: `${command.repoId} is a sample repo; it isn't in repos.yaml, so it can't be ${verb}.` } };
    }
    if (command.type === "init_repo" || command.type === "first_commit") {
      // The folder changes, not repos.yaml; it still waits its turn behind the other repo changes.
      const folderChange = repoChanges.then((): Promise<Result<unknown, RepoEditError>> =>
        command.type === "init_repo"
          ? initRepo(repoOptions(home), { path: command.path, ...(command.baseBranch === undefined ? {} : { baseBranch: command.baseBranch }) })
          : makeFirstCommit(repoOptions(home), { path: command.path }),
      );
      repoChanges = folderChange.catch(() => undefined);
      const done = await folderChange;
      if (!done.ok) return { ok: false, error: done.error };
      log(command.type === "init_repo" ? "set up git in a folder" : "made a first commit in a folder");
      return { ok: true, data: done.value };
    }
    const change = repoChanges.then(() =>
      command.type === "add_repo"
        ? addRepo(repoOptions(home), {
            path: command.path,
            ...(command.id === undefined ? {} : { id: command.id }),
            ...(command.baseBranch === undefined ? {} : { baseBranch: command.baseBranch }),
            ...(command.checks === undefined ? {} : { checks: command.checks }),
          })
        : command.type === "update_repo"
          ? updateRepo(repoOptions(home), { repoId: command.repoId, baseBranch: command.baseBranch, checks: command.checks })
          : removeRepo(repoOptions(home), command.repoId),
    );
    repoChanges = change.catch(() => undefined);
    const result = await change;
    if (!result.ok) return { ok: false, error: result.error };
    // Real mode reads the repos again, so the run loop sees the change at once, and diagnostics
    // clean the new repo's name and folder from then on.
    await Promise.all([(await realEngine)?.refresh(), diagnostics?.refreshRepos()]);
    broadcast({ type: "setup_changed" });
    log(`${{ add_repo: "added", update_repo: "updated", remove_repo: "removed" }[command.type]} repo ${result.value.id}`);
    if (command.type === "remove_repo") return { ok: true, data: null };
    const repo = { id: result.value.id, baseBranch: result.value.baseBranch, checks: [...result.value.checks] };
    return { ok: true, data: command.type === "add_repo" ? ({ repo } satisfies AddRepoResult) : ({ repo } satisfies UpdateRepoResult) };
  };

  const noDiagnostics: ReplyResult = { ok: false, error: { code: "not_implemented" satisfies CommandErrorCode, message: "this engine keeps no diagnostics" } };

  /** The crash flag for the setup's health, when the engine keeps diagnostics. */
  const crashFlag = () => (diagnostics === undefined ? {} : { crashWaiting: diagnostics.store.settings().crashWaiting });

  /** The sample setup in sample mode, with the repos of repos.yaml after its own. */
  const setup = async (): Promise<SetupResult> => {
    const base: SetupResult = sample ? { ...sample.setup, repos: sample.setup.repos.map((repo) => ({ ...repo, sample: true as const })) } : {
          repos: [],
          connections: [],
          agents: [],
          templates: [],
          health: { git: { ok: true }, clis: [], config: realFailure === undefined ? [] : [{ file: "engine", message: realFailure }], ...crashFlag() },
        };
    if (options.home === undefined) return base;
    const loaded = await loadRepos({ tokamaHome: options.home });
    if (!loaded.ok) {
      log(`repos.yaml is not loaded: ${loaded.error.problems.map(formatProblem).join("; ")}`);
      return base;
    }
    const added = loaded.value.filter((repo) => !base.repos.some((known) => known.id === repo.id));
    return { ...base, repos: [...base.repos, ...added.map((repo) => ({ id: repo.id, baseBranch: repo.baseBranch, checks: [...repo.checks], path: displayPath(repo.path) }))] };
  };

  /** Every template file, read again on each query so the page shows the files as they are now. */
  // The sample templates in sample mode, then each configured repo's templates and the built-ins.
  // A loaded template also gets the reasons it cannot start now, as on the setup's summary.
  const templateFiles = async (): Promise<TemplateFiles> => {
    const samples = sample ? await sampleTemplateLoads() : [];
    if (options.home === undefined) return { loads: samples, repoPath: () => undefined };
    const config = await loadConfig(options.home);
    const loads = config.templates.map((load) => {
      if (!load.ok) return load;
      const start = startProblem(load.template);
      return { ...load, warnings: [...(start === undefined ? [] : [start]), ...stepProblems(load.template, agentsFor(config, load.template)), ...load.warnings] };
    });
    return { loads: [...samples, ...loads], repoPath: (id) => config.repos.find((repo) => repo.id === id)?.path };
  };

  const dispatch = async (message: ClientMessage): Promise<ReplyResult> => {
    const result = await answer(message);
    if (result.ok && message.kind === "command") diagnostics?.countCommand(message.command, (id) => store.list().find((item) => item.id === id), result.data);
    return result;
  };

  const answer = async (message: ClientMessage): Promise<ReplyResult> => {
    // Real mode answers once its config is read and its items are projected into the store.
    const real = await realEngine;
    if (real !== undefined) {
      if (message.kind === "command") {
        const { command } = message;
        if (!isRepoCommand(command) && !isDiagnosticsCommand(command)) {
          const result = await real.command(command);
          return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
        }
      } else if (message.query.type === "setup") {
        const current = await real.setup();
        diagnostics?.setClis(current.health.clis);
        servedSetup = { ...current, health: { ...current.health, ...crashFlag() } };
        return { ok: true, data: servedSetup };
      } else if (message.query.type === "suggest_template") { return { ok: true, data: { templateId: await real.suggestTemplate() } as SuggestTemplateResult };
      } else if (message.query.type === "decision_diff") {
        const diff = await real.decisionDiff(message.query.itemId, message.query.decisionId);
        return diff.ok ? { ok: true, data: diff.value satisfies DecisionDiffResult } : { ok: false, error: diff.error };
      } else if (message.query.type === "step_output") {
        const output = await real.stepOutput(message.query.itemId, message.query.stepIndex, message.query.attempt);
        return output.ok ? { ok: true, data: output.value satisfies StepOutputResult } : { ok: false, error: output.error };
      } else if (message.query.type === "attempt_checks") {
        const { itemId, stepIndex, attempt } = message.query;
        const checks = await real.attemptChecks(itemId, stepIndex, attempt);
        return checks.ok ? { ok: true, data: checks.value satisfies AttemptChecksResult } : { ok: false, error: checks.error };
      } else if (message.query.type === "attempt_log") {
        const { itemId, stepIndex, attempt } = message.query;
        const log = await real.attemptLog(itemId, stepIndex, attempt);
        return log.ok ? { ok: true, data: log.value satisfies AttemptLogResult } : { ok: false, error: log.error };
      } else if (message.query.type === "attempt_file") {
        const { itemId, stepIndex, attempt, file } = message.query;
        const found = await real.attemptFile(itemId, stepIndex, attempt, file);
        return found.ok ? { ok: true, data: found.value satisfies AttemptFileResult } : { ok: false, error: found.error };
      }
    }
    if (message.kind === "command") {
      const command = message.command;
      if (isRepoCommand(command)) return repoCommand(command);
      if (isDiagnosticsCommand(command)) return diagnostics?.command(command) ?? noDiagnostics;
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
        servedSetup = await setup();
        return { ok: true, data: servedSetup };
      case "board":
        return { ok: true, data: { items: store.list() } satisfies BoardResult };
      case "item_list": {
        const names = query.q === undefined || query.q.trim() === "" ? undefined : nameHits(servedSetup ?? (real === undefined ? await setup() : await real.setup()), query.q);
        const page = list.page(query, names);
        // A page ends early at half the message limit; its cursor then goes on from its last row.
        const items: ItemRecord[] = [];
        let bytes = 0;
        let cut = false;
        for (const id of page.ids) {
          const item = store.get(id);
          if (item === undefined) continue;
          bytes += Buffer.byteLength(JSON.stringify(item));
          if (items.length > 0 && bytes > LIST_REPLY_BUDGET) {
            cut = true;
            break;
          }
          items.push(item);
        }
        const last = items.at(-1);
        const nextCursor = cut && last !== undefined ? `${last.createdAt}:${last.id}` : page.nextCursor;
        const shownDays = new Set(items.map((item) => localDate(item.createdAt)));
        const days = page.days.filter((day) => shownDays.has(day.day));
        return { ok: true, data: { items, nextCursor, total: page.total, days } satisfies ItemListResult };
      }
      case "item": {
        const item = store.get(query.itemId);
        return item ? { ok: true, data: { item } satisfies ItemResult } : { ok: false, error: { code: "not_found", message: `no item ${query.itemId}` } };
      }
      case "activity":
        if (store.get(query.itemId) === undefined) return { ok: false, error: { code: "not_found", message: `no item ${query.itemId}` } };
        return { ok: true, data: { activity: activity.get(query.itemId) } satisfies ActivityResult };
      case "decision_diff": {
        const diff = sample?.decisionDiff(query.itemId, query.decisionId);
        if (diff === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine serves no items" } };
        return diff.ok ? { ok: true, data: diff.value satisfies DecisionDiffResult } : { ok: false, error: diff.error };
      }
      case "step_output": {
        const output = sample?.stepOutput(query.itemId, query.stepIndex, query.attempt);
        if (output === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine serves no items" } };
        return output.ok ? { ok: true, data: output.value satisfies StepOutputResult } : { ok: false, error: output.error };
      }
      case "attempt_checks": {
        const checks = sample?.attemptChecks(query.itemId, query.stepIndex, query.attempt);
        if (checks === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine serves no items" } };
        return checks.ok ? { ok: true, data: checks.value satisfies AttemptChecksResult } : { ok: false, error: checks.error };
      }
      case "attempt_log": {
        const log = sample?.attemptLog(query.itemId, query.stepIndex, query.attempt);
        if (log === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine serves no items" } };
        return log.ok ? { ok: true, data: log.value satisfies AttemptLogResult } : { ok: false, error: log.error };
      }
      case "attempt_file":
        return { ok: false, error: { code: "not_found", message: sample === undefined ? "this engine serves no items" : "The sample items have no saved files to open." } };
      case "suggest_template":
        return { ok: true, data: { templateId: sample?.suggestTemplate(query.text) ?? null } satisfies SuggestTemplateResult };
      case "suggest_repo": {
        if (options.home === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine has no Tokama home folder for repos.yaml" } };
        const suggested = await suggestRepo(repoOptions(options.home), query.path);
        if (!suggested.ok) return { ok: false, error: suggested.error };
        const { path, displayPath, gitRepo, hasCommits, branch, id, checks, checksFrom, branches, fallbackCheck, fallbackFromPackage, firstCommit, problem } = suggested.value;
        return { ok: true, data: { path, displayPath, gitRepo, hasCommits, branch: branch ?? null, id: id ?? null, checks: [...checks], checksFrom: [...checksFrom], branches: [...branches], fallbackCheck: fallbackCheck ?? null, fallbackFromPackage, firstCommit: firstCommit === undefined ? null : { files: firstCommit.files, bytes: firstCommit.bytes, sample: firstCommit.sample.map((file) => ({ ...file })), more: [...firstCommit.more], addsGitignore: firstCommit.addsGitignore, leftOut: firstCommit.leftOut.map((entry) => ({ ...entry })), refusal: firstCommit.refusal ?? null }, problem: problem ?? null } satisfies SuggestRepoResult };
      }
      case "agents_list":
        if (options.home === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine has no Tokama home folder for agents" } };
        return { ok: true, data: (await listAgents(options.home)) satisfies AgentsListResult };
      case "ai_clis": {
        // The same checks and agents as the setup, so the page and the rest of the app agree.
        const current = real === undefined ? await setup() : await real.setup();
        return { ok: true, data: aiClis({ clis: current.health.clis, agents: current.agents, env: process.env }) satisfies AiClisResult };
      }
      case "templates":
        return { ok: true, data: { templates: templateEntries(await templateFiles()) } satisfies TemplatesResult };
      case "template_detail": {
        const detail = templateDetail(await templateFiles(), { origin: query.origin, file: query.file });
        if (detail === undefined) return { ok: false, error: { code: "not_found", message: `no template file ${query.file} in ${query.origin}` } };
        return { ok: true, data: detail satisfies TemplateDetailResult };
      }
      case "usage":
        return { ok: true, data: (await usage.report(query.range, query.scope)) satisfies UsageResult };
      case "diagnostics_list":
      case "diagnostics_settings":
        return diagnostics?.query(query) ?? noDiagnostics;
      case "machine": {
        if (sample !== undefined) return { ok: true, data: sampleMachineReport(store.list(), clock.now()) satisfies MachineResult };
        if (machine === undefined) return { ok: false, error: { code: "not_implemented", message: "this engine cannot read the machine on this operating system" } };
        const report = await machine.report();
        return report.ok ? { ok: true, data: report.value satisfies MachineResult } : { ok: false, error: { code: "unavailable", message: report.error.slice(0, 1000) } };
      }
    }
  };

  // Items a restart would pause: those running a step, and done items running a Finish action.
  // A store that cannot list leaves the count out, so the handshake still goes through.
  const runningItems = (): { runningItems?: number } => {
    try {
      return { runningItems: store.list().filter((item) => item.state === "running" || item.finish?.running !== undefined).length };
    } catch {
      return {};
    }
  };

  const handleHello = (socket: Socket, line: string): boolean => {
    const opening = parseJsonLine(line);
    const hello = parseOpeningMessage(opening.ok ? opening.value : undefined);
    if (!hello.ok) {
      fail(socket, "bad_message", "the first message must be a hello");
      return false;
    }
    if (!sameToken(token, hello.value.token)) {
      fail(socket, "unauthorized", "wrong engine token");
      return false;
    }
    // A shutdown request is accepted from any version: a newer app replaces this engine with it.
    if (hello.value.kind === "shutdown") {
      log(`a client with API version ${hello.value.apiVersion} asked the engine to stop`);
      const accepted = encodeLine({ kind: "shutdown_accepted", apiVersion: API_VERSION });
      if (accepted.ok) write(socket, accepted.value);
      socket.end();
      void shutdown();
      return false;
    }
    if (hello.value.apiVersion !== API_VERSION) {
      fail(socket, "unsupported_version", `engine speaks API version ${API_VERSION}, client sent ${hello.value.apiVersion}`, runningItems());
      return false;
    }
    const welcome = encodeLine({ kind: "welcome", apiVersion: API_VERSION, engineId, ...runningItems() });
    if (welcome.ok) write(socket, welcome.value);
    ready.add(socket);
    return true;
  };

  const handleMessage = (socket: Socket, line: string) => {
    const parsedLine = parseJsonLine(line);
    const json = parsedLine.ok ? parsedLine.value : undefined;
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
        diagnostics?.store.error("engine", "request", error);
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
  usageRecorded = usageChanged;
  pushActivity = (latest) => broadcast({ type: "item_activity", activity: latest });
  diagnosticsChanged = () => broadcast({ type: "setup_changed" });
  entriesChanged = () => broadcast({ type: "diagnostics_changed" });

  const stopTicking = sample?.startTicking();

  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const shutdown = async () => {
    if (shuttingDown) return closed;
    shuttingDown = true;
    stopTicking?.();
    pushActivity = () => {};
    activity.close();
    unsubscribe();
    usageRecorded = () => {};
    diagnosticsChanged = () => {};
    entriesChanged = () => {};
    usageAbort.abort();
    await withDeadline(clock, Promise.allSettled([...inFlight, usage.settled(), machine?.close(), claudeLogs?.settled()]), shutdownTimeoutMs);
    const allClosed = new Promise<void>((resolve) => {
      onAllClosed = resolve;
      if (connections.size === 0) resolve();
    });
    for (const socket of connections) socket.end();
    await withDeadline(clock, allClosed, shutdownTimeoutMs);
    for (const socket of connections) socket.destroy();
    // The run loop writes to the item logs; it must be done before another engine may open them.
    await (await realEngine)?.close().catch((error: unknown) => {
      log(`closing the run loop failed: ${String(error)}`);
      diagnostics?.store.error("engine", "shutdown", error);
    });
    // Closing the server removes the socket file. Only then may another engine take over.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    releaseStorage();
    unfollowList();
    list.close();
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
  // The AI CLIs entries name, once the startup checks are done; the setup query keeps them current.
  if (real !== undefined && diagnostics !== undefined) {
    const known = diagnostics;
    void real.setup().then((current) => known.setClis(current.health.clis), () => undefined);
  }
  if (real !== undefined && !shuttingDown) {
    const recoveryFailed = (error: unknown) => {
      log(`restart recovery failed: ${String(error)}`);
      diagnostics?.store.error("engine", "recovery", error);
      return [];
    };
    for (const recovered of await real.ready.catch(recoveryFailed)) {
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
  /** The board and usage index, rebuilt from the item logs. */
  readonly index: ItemIndex;
  close(): void;
}

/** Loads the item logs and rebuilds the board index from them. The index follows every change after that. */
async function openStorage(home: string, clock: Clock, log: (message: string) => void, onUsage: () => void, diagnostics?: EngineDiagnostics): Promise<Result<Storage, StartError>> {
  let index: ItemIndex | undefined;
  try {
    const hostId = loadHostId(home, clock);
    if (!hostId.ok) return err({ code: "start_failed", message: hostId.error });
    const { store: items, problems } = ItemStore.open({ home, hostId: hostId.value, clock });
    for (const problem of problems) {
      log(`item ${problem.itemId} is not loaded: ${problem.message}`);
      diagnostics?.store.warning("engine", "item_not_loaded");
    }
    index = openIndex(join(home, "tokama.db"), items.list(), clock, log, () => diagnostics?.store.warning("engine", "index_rebuilt"));
    const opened = index;
    const unsubscribe = items.subscribe((item) => {
      // The event is on disk already; a failed index write must not fail the append.
      try {
        if (opened.put(item) > 0) onUsage();
      } catch (error) {
        log(`cannot update the board index for ${item.id}: ${String(error)}`);
        diagnostics?.store.error("engine", "storage", error);
      }
    });
    return ok({
      items,
      index: opened,
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
function openIndex(file: string, items: readonly StoredItem[], clock: Clock, log: (message: string) => void, onRebuild: () => void): ItemIndex {
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
    onRebuild();
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
    if (live.live) {
      const starting = live.startingPid === undefined ? "" : ` (pid ${live.startingPid}, still starting: it does not answer yet)`;
      return err({ code: "already_running", message: `an engine is already running on ${live.socketPath}${starting}` });
    }
    log(`removing a stale lock in ${endpoint.dir}`);
    unlinkIfPresent(endpoint.lockPath);
  }
  return err({ code: "already_running", message: `another engine is starting in ${endpoint.dir}` });
}

/**
 * A lock whose third field names a socket (the home lock) is probed on that socket; the engine
 * dir's lock is probed on the dir's socket.
 *
 * A lock whose engine does not answer yet is live while the process that wrote it still runs,
 * however long it has been starting (a large item log, a board index rebuild, a slow disk). The
 * writer is the process with the lock's pid that started before the lock was written; a process
 * that started later took the pid over after the engine died. When the start time cannot be read,
 * the lock counts as live: a refused start is safe, two engines on one home are not.
 */
async function lockIsLive(endpoint: LockSpec): Promise<{ live: boolean; socketPath: string; startingPid?: number }> {
  const lock = readPidFile(endpoint.lockPath);
  if (lock === undefined) return { live: await socketAnswers(endpoint.socketPath), socketPath: endpoint.socketPath };
  const socketPath = lock.fields.slice(2).join(" ") || endpoint.socketPath;
  if (await socketAnswers(socketPath)) return { live: true, socketPath };
  if (lock.pid === undefined) return { live: Date.now() - lock.writtenAt < STARTING_GRACE_MS, socketPath };
  if (!pidAlive(lock.pid)) return { live: false, socketPath };
  const info = await posixEngineProcesses.describe(lock.pid).catch(() => "unknown" as const);
  // Nothing read: the process has exited since, or ps printed something unexpected.
  const live = info === undefined ? pidAlive(lock.pid) : info === "unknown" || info.startedAt <= lock.writtenAt + START_TIME_SLACK_MS;
  return live ? { live, socketPath, startingPid: lock.pid } : { live, socketPath };
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
  const written = replaceTextSync(tokenPath, token, 0o600);
  if (!written.ok) throw new Error(`cannot write ${tokenPath}: ${written.error.message}`);
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
