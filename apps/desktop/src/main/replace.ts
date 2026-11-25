// Replaces an older engine of this app that still runs after an update: it is stopped (only after
// core checks that the lock's pid really is this app's engine for this engine dir), then the
// caller connects again and starts the new one as usual. No Electron here.
//
// Two apps may find the same older engine. The first one takes `replace.lock` in the engine dir
// and stops it; the other sends nothing and waits until the old engine lets go of its lock.
// eslint-disable-next-line no-restricted-imports -- replace.lock is created exclusively (O_EXCL), which is the lock itself; an atomic replace cannot take a lock.
import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, readEngineLock, readPidFile, stopOwnEngine, type EngineProcesses, type OwnEngine, type StopOutcome } from "@tokama/core";

export type ReplaceResult =
  /** The old engine is gone; connect again. `forced`: it took SIGKILL, so it could not end cleanly. */
  | { readonly ok: true; readonly forced: boolean }
  | { readonly ok: false; readonly reason: string };

export interface ReplaceOptions {
  /** The engine dir. */
  readonly dir: string;
  /** The engine id the lock named when the older engine was found; a lock naming another engine is left alone. */
  readonly expectedEngineId?: string;
  readonly engine: OwnEngine;
  readonly processes: EngineProcesses;
  /** Sends the shutdown request to the engine in `dir`; true when it accepted. */
  readonly requestShutdown: (dir: string) => Promise<boolean>;
  /** How long each stop step waits. Default 15 s. */
  readonly stepMs?: number;
  /** How often it looks while waiting. Default 200 ms. */
  readonly pollMs?: number;
  /** How long another app's replace may take before its `replace.lock` counts as stale. Default 60 s. */
  readonly staleMs?: number;
}

const REPLACE_LOCK = "replace.lock";

export async function replaceOlderEngine(options: ReplaceOptions): Promise<ReplaceResult> {
  const lockPath = join(options.dir, REPLACE_LOCK);
  const staleMs = options.staleMs ?? 60_000;
  const mine = `${process.pid} ${Date.now()}\n`;
  if (!takeLock(lockPath, mine, staleMs)) return waitForOther(options, lockPath, staleMs);
  try {
    const outcome = await stopOwnEngine(options.engine, {
      ...(options.expectedEngineId !== undefined && { expectedEngineId: options.expectedEngineId }),
      processes: options.processes,
      requestShutdown: () => options.requestShutdown(options.dir),
      ...(options.stepMs !== undefined && { stepMs: options.stepMs }),
      ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
    });
    return result(outcome, options.engine.lockPath);
  } finally {
    releaseLock(lockPath, mine);
  }
}

function result(outcome: StopOutcome, lockPath: string): ReplaceResult {
  switch (outcome.kind) {
    case "stopped":
      return { ok: true, forced: outcome.by === "sigkill" };
    case "replaced":
      return { ok: true, forced: false };
    case "still_running":
      return { ok: false, reason: `The older Tokama engine (pid ${outcome.lock.pid}) did not stop, even after SIGKILL. Lock: ${lockPath}. Press Retry to try again.` };
    case "refused":
      // It stopped by itself meanwhile: connect, and the new engine starts.
      if (outcome.reason === "no_lock" || outcome.reason === "gone") return { ok: true, forced: false };
      if (outcome.reason === "unreadable") return { ok: false, reason: `Tokama could not read the process list (ps) to check pid ${outcome.pid ?? "?"} in ${lockPath}, so it stopped nothing. Press Retry.` };
      return {
        ok: false,
        reason: `An engine of another version is running, but Tokama could not confirm that pid ${outcome.pid ?? "?"} in ${lockPath} is its own engine for this folder, so it stopped nothing. Stop that engine yourself, then press Retry.`,
      };
  }
}

/**
 * Another app is replacing the engine: wait until the old engine lets go of its lock, or the other
 * app is done (its `replace.lock` is gone or stale). Either way the caller connects again and sees
 * the outcome for itself.
 */
async function waitForOther(options: ReplaceOptions, replaceLock: string, staleMs: number): Promise<ReplaceResult> {
  const before = readEngineLock(options.engine.lockPath);
  const deadline = Date.now() + staleMs;
  while (Date.now() < deadline) {
    const now = readEngineLock(options.engine.lockPath);
    if (before === undefined || now === undefined || now.pid !== before.pid || now.engineId !== before.engineId) return { ok: true, forced: false };
    if (isStale(replaceLock, staleMs)) return { ok: true, forced: false };
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
  }
  return { ok: false, reason: `Another Tokama window is replacing the older engine, and it has not finished. Lock: ${options.engine.lockPath}. Press Retry.` };
}

/** Creates the lock file; false while another app holds it. A lock older than `staleMs`, or unreadable, is taken over once. */
function takeLock(path: string, content: string, staleMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      // A lock that cannot be made at all does not stop this app's own replace.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return true;
    }
    if (!isStale(path, staleMs)) return false;
    try {
      unlinkSync(path);
    } catch {
      // Removed by the other app meanwhile.
    }
  }
  return false;
}

/**
 * Stale: gone, unreadable, older than `staleMs`, or its app (the pid in it) is no longer running.
 * A lock with no pid yet is being written: stale only once it is old.
 */
function isStale(path: string, staleMs: number): boolean {
  const lock = readPidFile(path);
  if (lock === undefined || Date.now() - lock.writtenAt > staleMs) return true;
  return lock.pid !== undefined && !pidAlive(lock.pid);
}

function releaseLock(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) unlinkSync(path);
  } catch {
    // Already gone.
  }
}
