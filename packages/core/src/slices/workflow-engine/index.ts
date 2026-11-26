// Public surface of the workflow-engine slice.
export { createRunLoop, titleFrom, type CommandError, type RunLoop, type RunLoopDeps, type StartItemInput } from "./run-loop.js";
export { attemptLimit, ROUND_TRIPS } from "./counters.js";
export { createFinisher, type Finisher, type FinishDeps, type FinishError } from "./finish.js";
export { parseVerdict, VERDICT_RULE, type Verdict } from "./verdict.js";
export { explainStop, lastEnded, type Stopped } from "./explain.js";
export { summarizeOutput } from "./summary.js";
