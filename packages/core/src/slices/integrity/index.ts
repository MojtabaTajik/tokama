// Public surface of the integrity slice.
export { baseCategory, patternCategory, type ProtectedCategory } from "./protected.js";
export { readChange, summarizeChange } from "./change.js";
export { risk, type RiskFacts } from "./risk.js";
export {
  protectedSet,
  sharedGitHashes,
  sharedGitSettings,
  type GitSetting,
  tamperChanges,
  type IntegrityError,
  type ProtectedArea,
  type ProtectedFile,
  type ProtectedHashes,
  type ProtectedSet,
  type ProtectedSetInput,
  type TamperChange,
  type WalkLimits,
} from "./tamper.js";
