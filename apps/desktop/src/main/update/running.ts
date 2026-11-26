// How many items the engine runs now, asked of the engine itself: its own count, with its own
// definition (a running item, or one that is finishing). The update waits for it to be zero. The
// answer also says which API version the engine speaks, so a stop knows whether it understands `ifIdle`.
import type { ConnectError } from "@tokama/client";

export interface RunningDeps {
  readonly lockPath: () => string | undefined;
  readonly readLock: (lockPath: string) => { readonly pid: number } | undefined;
  readonly pidAlive: (pid: number) => boolean;
  /** Connects to a running engine without starting one. */
  readonly connect: () => Promise<
    { ok: true; value: { readonly engine: { readonly apiVersion?: number; readonly runningItems?: number }; close(): Promise<void> } } | { ok: false; error: Pick<ConnectError, "code" | "engine"> }
  >;
}

export interface RunningCount {
  /**
   * 0 when no engine runs, so there is nothing to stop. The engine's count otherwise. undefined
   * when an engine runs but did not say, so the caller must treat it as busy.
   */
  readonly items: number | undefined;
  /** The API version of the engine that answered; absent when none runs or none could be reached. */
  readonly apiVersion?: number;
}

export async function runningNow(deps: RunningDeps): Promise<RunningCount> {
  const lockPath = deps.lockPath();
  if (lockPath === undefined) return { items: undefined };
  const lock = deps.readLock(lockPath);
  if (lock === undefined || !deps.pidAlive(lock.pid)) return { items: 0 };
  const connected = await deps.connect().catch(() => undefined);
  if (connected === undefined) return { items: undefined };
  // An engine of another API version refuses the handshake but still says how many items it runs.
  if (!connected.ok) {
    if (connected.error.code !== "unsupported_version") return { items: undefined };
    const engine = connected.error.engine;
    return { items: engine?.runningItems, ...(engine !== undefined && { apiVersion: engine.apiVersion }) };
  }
  try {
    const { runningItems, apiVersion } = connected.value.engine;
    return { items: runningItems, ...(apiVersion !== undefined && { apiVersion }) };
  } finally {
    await connected.value.close().catch(() => undefined);
  }
}
