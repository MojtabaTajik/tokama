import type { ProcessTree } from "./runner.js";

/**
 * macOS and Linux: the child leads a new process group (`detached: true`), so a signal to
 * `-pid` reaches it and every descendant that stayed in the group. A descendant that starts
 * its own session or group (setsid, a detached spawn) leaves the tree and is not reached.
 */
export const posixTree: ProcessTree = {
  detached: true,
  shellArgv: (script) => ["/bin/sh", "-c", script],
  signalTree(pid, signal) {
    // -0 and -1 would signal our own group or every process we may signal.
    if (!Number.isInteger(pid) || pid <= 1) throw new RangeError(`not a child pid: ${pid}`);
    try {
      process.kill(-pid, signal);
    } catch (error) {
      // ESRCH: the group is gone. EPERM: macOS reports it for a group of zombies only.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
  },
};
