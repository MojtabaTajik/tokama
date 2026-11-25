// kernel/process: spawn agents and checks, stream their output to disk as it arrives, kill the
// whole process tree on stop or timeout, pass only allowlisted environment variables, kill
// an agent tree left over from before a restart, and read the pid files that name a process.
// spawnDetached (detached.ts) is exported from core's public entry only: it is for clients that
// start the engine, not for slices or adapters.
export { ENV_ALLOWLIST, buildEnv } from "./env.js";
export { pidAlive, readPidFile, type PidFile } from "./pid-file.js";
export { findOnPath } from "./which.js";
export { posixTree } from "./posix.js";
export {
  killLeftoverTree,
  parsePsOutput,
  posixProcessTable,
  type KillLeftoverOptions,
  type LeftoverOutcome,
  type LeftoverRecord,
  type ProcessInfo,
  type ProcessTable,
} from "./leftover.js";
export {
  createProcessRunner,
  type OutputSink,
  type ProcessCommand,
  type ProcessRunner,
  type ProcessTree,
  type RunFinished,
  type RunNotStarted,
  type RunRequest,
  type RunResult,
  type RunnerOptions,
  type TreeSignal,
} from "./runner.js";
