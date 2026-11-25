// Starts a background service (the engine) that outlives the process that starts it.
import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { closeSync, fchmodSync, openSync, readdirSync } from "node:fs";
import { devNull } from "node:os";
import { err, ok, type Result } from "../result/index.js";

export type { ChildProcess };

export interface DetachedService {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Gets the service's stdout and stderr, appended; created 0600 when missing. */
  readonly logPath: string;
}

/**
 * Spawns the service detached and unreferenced, so it keeps running when this process exits.
 * Fails when the log or the null device cannot be opened; a spawn that throws still throws. The
 * caller owns the child: it watches `error` and `exit` itself.
 */
export function spawnDetached(service: DetachedService): Result<ChildProcess, { readonly message: string }> {
  let logFd: number;
  let nullFd: number;
  try {
    logFd = openSync(service.logPath, "a", 0o600);
    try {
      nullFd = openSync(devNull, "r");
    } catch (error) {
      closeSync(logFd);
      throw error;
    }
  } catch (error) {
    return err({ message: `cannot prepare ${service.logPath}: ${String(error)}` });
  }
  try {
    // The mode given to open applies only to a new file; an existing log is made private too.
    fchmodSync(logFd, 0o600);
    // stdout and stderr go to the log through the fd, which works for a detached child.
    // Every other descriptor this process has open is pointed at the null device: the service would
    // otherwise keep them. Electron on Linux leaves pipes and files open in its children, and a
    // parent that waits for its pipes to close (Playwright, on `app.close()`) then waits for the
    // detached service to exit.
    const stdio: StdioOptions = ["ignore", logFd, logFd, ...Array.from({ length: openFdCount() - 3 }, () => nullFd)];
    const child = spawn(service.command, [...service.args], { detached: true, stdio, env: service.env });
    child.unref();
    return ok(child);
  } finally {
    closeSync(logFd);
    closeSync(nullFd);
  }
}

/** One more than the highest descriptor this process has open, at least 3. */
function openFdCount(): number {
  try {
    return Math.max(3, ...readdirSync("/dev/fd").map((name) => Number.parseInt(name, 10) + 1));
  } catch {
    return 3;
  }
}
