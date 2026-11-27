// Public surface of the workflow-engine slice.
export { createRunLoop, titleFrom, type CommandError, type RunLoop, type RunLoopDeps, type StartItemInput } from "./run-loop.js";
export { attemptLimit, ROUND_TRIPS } from "./counters.js";
export { itemRisk } from "./item-risk.js";
export { createFinisher, type Finisher, type FinishDeps, type FinishError } from "./finish.js";
export { parseVerdict, VERDICT_RULE, type Verdict } from "./verdict.js";
export { explainStop, lastEnded, type Stopped } from "./explain.js";
export {
  checkLimitMinutes,
  createCheckTrialRunner,
  tidyOutput,
  trialCommandProblem,
  type CheckTrialDeps,
  type CheckTrialError,
  type CheckTrialHooks,
  type CheckTrialRequest,
  type CheckTrialRunner,
  type PreparedCheckTrial,
} from "./check-trial.js";
export { summarizeOutput } from "./summary.js";
export { chooseHelperAgent, HELPER_LOCAL_ONLY, HELPER_NO_CLI, HELPER_TARGETS, type CliStatus, type HelperAgentChoice, type HelperAgentDeps } from "./helper-agent.js";
export {
  cleanCliText,
  createHelperRunner,
  helperDisclosure,
  type HelperCallRecord,
  type HelperCommandError,
  type HelperGatherer,
  type HelperOutcome,
  type HelperRunHooks,
  type HelperRunner,
  type HelperRunnerDeps,
  type PreparedHelperRun,
} from "./helper-runner.js";
