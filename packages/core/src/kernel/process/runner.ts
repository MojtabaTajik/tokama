import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { systemClock, type Clock, type TimerHandle } from "../clock/index.js";
import { buildEnv } from "./env.js";
import { posixTree } from "./posix.js";

export type TreeSignal = "SIGTERM" | "SIGKILL";

/** The OS-specific part of process control. One implementation per OS (POSIX now, Windows later). */
export interface ProcessTree {
  /** Spawn the child as the root of its own tree (a new process group on POSIX). */
  readonly detached: boolean;
  /** argv that runs `script` in the platform shell. */
  shellArgv(script: string): string[];
  /** Signals the child and its descendants. Never throws for a tree that is already gone. */
  signalTree(pid: number, signal: TreeSignal): void;
}

/** argv runs without a shell. A shell runs only when the caller asks for one. */
export type ProcessCommand = { readonly argv: readonly [string, ...string[]] } | { readonly shell: string };

export interface OutputSink {
  /**
   * Created or truncated with mode 0600 (transcripts can hold secrets); a symlink at the path is
   * refused. Raw bytes are written as they arrive, before any callback runs. stdout and stderr
   * may name the same file.
   */
  readonly file?: string;
  /** Called once per line, without the line break. A throw stops the process and rejects the run. */
  readonly onLine?: (line: string) => void;
}

export interface RunRequest {
  readonly command: ProcessCommand;
  readonly cwd: string;
  /** Added to the allowlisted parent variables; may override them. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Written to the child's stdin, which is then closed. Use it for data that must stay off the argv
   * (visible to every local user in `ps`), such as a secret. Without it, stdin is /dev/null.
   */
  readonly stdin?: string;
  readonly stdout?: OutputSink;
  readonly stderr?: OutputSink;
  /**
   * Called once with the child's pid right after it started. On POSIX the pid is also the id of
   * the child's process group, so a caller can record it and kill a leftover tree after a restart.
   * A throw stops the process and rejects the run.
   */
  readonly onSpawn?: (pid: number) => void;
}

export interface RunFinished {
  readonly kind: "finished";
  readonly pid: number;
  /** null when a signal ended the process. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /**
   * The timeout stop ended the child: it died by a signal, or it exited with the conventional
   * code for a stop signal the runner sent (143 after SIGTERM, 137 after SIGKILL), as a child
   * that traps SIGTERM does. A child that exited with any other code (e.g. 0, before the stop
   * reached it) reports false.
   */
  readonly timedOut: boolean;
  /** The abort stop ended the child; same rule as timedOut. */
  readonly aborted: boolean;
  readonly startedAt: number;
  /** When the child exited (output may drain a little later). */
  readonly endedAt: number;
  readonly durationMs: number;
}

export interface RunNotStarted {
  readonly kind: "not-started";
  readonly reason: "aborted" | "spawn-error";
  readonly message: string;
  readonly code?: string;
}

/** Expected failures are values; a rejection means a bug in a callback or an unwritable output file. */
export type RunResult = RunFinished | RunNotStarted;

export interface ProcessRunner {
  run(request: RunRequest): Promise<RunResult>;
}

export interface RunnerOptions {
  readonly tree?: ProcessTree;
  /** Time and timers; inject a manual clock to make timeout and grace tests deterministic. */
  readonly clock?: Clock;
  /** Source of the allowlisted variables. Default: process.env. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Time between SIGTERM and SIGKILL on a stop. */
  readonly killGraceMs?: number;
  /** How long to wait for output after the child exited (an escaped descendant may hold the pipes). */
  readonly drainMs?: number;
}

// O_NOFOLLOW does not exist on Windows; the Windows tree implementation will need its own guard.
const OUTPUT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

function defaultTree(): ProcessTree {
  if (process.platform === "win32") throw new Error("process control on Windows is not implemented yet");
  return posixTree;
}

export function createProcessRunner(options: RunnerOptions = {}): ProcessRunner {
  const tree = options.tree ?? defaultTree();
  const clock = options.clock ?? systemClock;
  const parentEnv = options.parentEnv ?? process.env;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const drainMs = options.drainMs ?? 2_000;

  return {
    run(request) {
      if (request.signal?.aborted) {
        return Promise.resolve({ kind: "not-started", reason: "aborted", message: "aborted before start" });
      }
      const argv = "argv" in request.command ? [...request.command.argv] : tree.shellArgv(request.command.shell);
      const [file, ...args] = argv;
      if (file === undefined) return Promise.reject(new TypeError("empty argv"));
      const env = buildEnv(parentEnv, request.env);
      const fds = new Map<string, number>();
      const openFile = (path: string | undefined) => {
        if (path === undefined) return undefined;
        const key = resolvePath(path);
        let fd = fds.get(key);
        if (fd === undefined) {
          fd = openSync(path, OUTPUT_FLAGS, 0o600);
          fds.set(key, fd);
          // The mode above applies only to a new file.
          fchmodSync(fd, 0o600);
        }
        return fd;
      };
      const closeFiles = () => {
        fds.forEach((fd) => closeSync(fd));
        fds.clear();
      };

      return new Promise<RunResult>((resolve, reject) => {
        let child: ChildProcess;
        let startedAt: number;
        const flushers: Array<() => void> = [];
        let stdoutFd: number | undefined;
        let stderrFd: number | undefined;
        try {
          stdoutFd = openFile(request.stdout?.file);
          stderrFd = openFile(request.stderr?.file);
        } catch (error) {
          closeFiles();
          reject(error);
          return;
        }
        try {
          startedAt = clock.now();
          child = spawn(file, args, {
            cwd: request.cwd,
            env,
            stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            detached: tree.detached,
            windowsHide: true,
          });
        } catch (error) {
          // Node throws some spawn failures (ENOTDIR, E2BIG) instead of emitting "error".
          closeFiles();
          resolve(spawnError(error as NodeJS.ErrnoException));
          return;
        }
        if (request.stdin !== undefined) {
          // A child that exits without reading its input makes the write fail with EPIPE; its exit
          // code still reports what happened.
          child.stdin?.on("error", () => {});
          child.stdin?.end(request.stdin);
        }
        flushers.push(pipeOutput(child.stdout, request.stdout, stdoutFd, fail));
        flushers.push(pipeOutput(child.stderr, request.stderr, stderrFd, fail));

        let stopping: "timeout" | "abort" | "failure" | undefined;
        let failure: { error: unknown } | undefined;
        let exit: { code: number | null; signal: NodeJS.Signals | null; at: number } | undefined;
        let settled = false;
        const timers = new Set<TimerHandle>();
        const later = (ms: number, callback: () => void) => {
          const handle = clock.setTimeout(() => {
            timers.delete(handle);
            callback();
          }, ms);
          timers.add(handle);
          return handle;
        };
        const cancel = (handle: TimerHandle | undefined) => {
          if (handle !== undefined && timers.delete(handle)) clock.clearTimeout(handle);
        };
        const signalTree = (signal: TreeSignal) => {
          if (child.pid !== undefined) tree.signalTree(child.pid, signal);
        };

        // Stop signals only; the cleanup kill after the exit does not count.
        const stopsSent = new Set<TreeSignal>();
        const stopSignal = (signal: TreeSignal) => {
          stopsSent.add(signal);
          signalTree(signal);
        };
        let grace: TimerHandle | undefined;
        function stop(why: "timeout" | "abort" | "failure") {
          // After the exit the tree was already killed; only draining is left.
          if (stopping !== undefined || exit !== undefined) return;
          stopping = why;
          stopSignal("SIGTERM");
          grace = later(killGraceMs, () => stopSignal("SIGKILL"));
        }
        function fail(error: unknown) {
          failure ??= { error };
          stop("failure");
        }
        const onAbort = () => stop("abort");
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.timeoutMs !== undefined) later(request.timeoutMs, () => stop("timeout"));
        if (child.pid !== undefined && request.onSpawn !== undefined) {
          try {
            request.onSpawn(child.pid);
          } catch (error) {
            fail(error);
          }
        }

        function finish(result: RunResult) {
          if (settled) return;
          settled = true;
          timers.forEach((handle) => clock.clearTimeout(handle));
          timers.clear();
          request.signal?.removeEventListener("abort", onAbort);
          flushers.forEach((flush) => flush());
          closeFiles();
          if (failure !== undefined) reject(failure.error);
          else resolve(result);
        }
        const finished = (): RunFinished => {
          const endedAt = exit?.at ?? clock.now();
          const stopped =
            exit !== undefined &&
            (exit.signal !== null ||
              (stopsSent.has("SIGTERM") && exit.code === 143) ||
              (stopsSent.has("SIGKILL") && exit.code === 137));
          return {
            kind: "finished",
            pid: child.pid ?? -1,
            exitCode: exit?.code ?? null,
            signal: exit?.signal ?? null,
            timedOut: stopping === "timeout" && stopped,
            aborted: stopping === "abort" && stopped,
            startedAt,
            endedAt,
            durationMs: endedAt - startedAt,
          };
        };

        child.once("error", (error: NodeJS.ErrnoException) => {
          // Only a failed spawn has no pid; other child errors come with an exit or close.
          if (child.pid === undefined) finish(spawnError(error));
        });
        child.once("exit", (code, signal) => {
          exit = { code, signal, at: clock.now() };
          cancel(grace);
          // Tools the call started in the background must not outlive it.
          signalTree("SIGKILL");
          later(drainMs, () => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(finished());
          });
        });
        child.once("close", () => {
          if (child.pid !== undefined) finish(finished());
        });
      });
    },
  };
}

function spawnError(error: NodeJS.ErrnoException): RunNotStarted {
  return {
    kind: "not-started",
    reason: "spawn-error",
    message: error.message,
    ...(error.code !== undefined && { code: error.code }),
  };
}

/** Writes each chunk to `fd`, then splits it into lines for `sink.onLine`. Returns a flush for the last partial line. */
function pipeOutput(
  stream: Readable | null,
  sink: OutputSink | undefined,
  fd: number | undefined,
  fail: (error: unknown) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let failed = false;
  const emit = (line: string) => {
    if (failed || sink?.onLine === undefined) return;
    try {
      sink.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    } catch (error) {
      failed = true;
      fail(error);
    }
  };
  stream?.on("data", (chunk: Buffer) => {
    if (failed) return;
    try {
      if (fd !== undefined) writeSync(fd, chunk);
    } catch (error) {
      failed = true;
      fail(error);
      return;
    }
    if (sink?.onLine === undefined) return;
    const lines = (partial + decoder.write(chunk)).split("\n");
    partial = lines.pop() ?? "";
    lines.forEach(emit);
  });
  return () => {
    const rest = partial + decoder.end();
    partial = "";
    if (rest !== "") emit(rest);
  };
}
