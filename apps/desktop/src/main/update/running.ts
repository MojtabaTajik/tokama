// How many items the engine runs now, asked of the engine itself: its own count, with its own
// definition (a running item, or one that is finishing). The update waits for it to be zero.
import type { ConnectError } from "@tokama/client";

export interface RunningDeps {
  readonly lockPath: () => string | undefined;
  readonly readLock: (lockPath: string) => { readonly pid: number } | undefined;
  readonly pidAlive: (pid: number) => boolean;
  /** Connects to a running engine without starting one. */
  readonly connect: () => Promise<
    { ok: true; value: { readonly engine: { readonly runningItems?: number }; close(): Promise<void> } } | { ok: false; error: Pick<ConnectError, "code" | "engine"> }
  >;
}

/**
 * 0 when no engine runs, so there is nothing to stop. The engine's count otherwise. undefined when
 * an engine runs but did not say, so the caller must treat it as busy.
 */
export async function runningNow(deps: RunningDeps): Promise<number | undefined> {
  const lockPath = deps.lockPath();
  if (lockPath === undefined) return undefined;
  const lock = deps.readLock(lockPath);
  if (lock === undefined || !deps.pidAlive(lock.pid)) return 0;
  const connected = await deps.connect().catch(() => undefined);
  if (connected === undefined) return undefined;
  // An engine of another API version refuses the handshake but still says how many items it runs.
  if (!connected.ok) return connected.error.code === "unsupported_version" ? connected.error.engine?.runningItems : undefined;
  try {
    return connected.value.engine.runningItems;
  } finally {
    await connected.value.close().catch(() => undefined);
  }
}
