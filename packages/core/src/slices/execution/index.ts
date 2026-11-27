// Public surface of the execution slice.
export { actionOf, type Action, type ActivityState, type ActivityTracker, createActivityTracker, labelText, redactPaths, toolSubject } from "./activity.js";
export { runGuardedCall, type GuardedCallOptions, type GuardedCallResult } from "./guarded-call.js";
export { callUsage, type CallUsageInput } from "./usage.js";
export {
  agentCliGuardDefaults,
  localModelGuardDefaults,
  loopGuardSettings,
  LoopGuardSettingsSchema,
  type FileSnapshot,
  type FileState,
  type GuardReport,
  type IdleWatchStats,
  type LoopGuardSettings,
  type StopReason,
} from "./loop-guard.js";
