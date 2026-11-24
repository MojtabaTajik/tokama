// kernel/process: spawn agents and checks, stream their output to disk as it arrives, kill the
// whole process tree on stop or timeout, pass only allowlisted environment variables.
// See docs/spec/architecture.md, sections 6 and 9.
export { ENV_ALLOWLIST, buildEnv } from "./env.js";
export { posixTree } from "./posix.js";
export {
  createProcessRunner,
  type Command,
  type OutputSink,
  type ProcessClock,
  type ProcessRunner,
  type ProcessTree,
  type RunFinished,
  type RunNotStarted,
  type RunRequest,
  type RunResult,
  type RunnerOptions,
  type TreeSignal,
} from "./runner.js";
