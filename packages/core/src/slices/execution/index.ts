// Public surface of the execution slice.
export { runGuardedCall, type GuardedCallOptions, type GuardedCallResult } from "./guarded-call.js";
export {
  DEFAULT_LOOP_GUARD_SETTINGS,
  loopGuardSettings,
  LoopGuardSettingsSchema,
  type FileSnapshot,
  type FileState,
  type GuardReport,
  type IdleWatchStats,
  type LoopGuardSettings,
  type StopReason,
} from "./loop-guard.js";
