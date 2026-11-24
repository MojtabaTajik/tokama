// Public surface of the integrity slice.
export { baseCategory, patternCategory, type ProtectedCategory } from "./protected.js";
export {
  protectedSet,
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
