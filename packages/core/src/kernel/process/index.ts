// kernel/process: spawn agents and checks, stream their output to disk as it arrives, kill the
// whole process tree on stop or timeout, pass only allowlisted environment variables, and kill
// an agent tree left over from before a restart.
export { ENV_ALLOWLIST, buildEnv } from "./env.js";
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
