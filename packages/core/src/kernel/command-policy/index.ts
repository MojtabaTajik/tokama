// kernel/command-policy: decide whether a check or step command may run, with one grammar per
// shell (POSIX `sh` now, PowerShell later). A guardrail, not a full shell parser.
export {
  PIPE_HELPERS,
  checkCommand,
  rulePrefixes,
  type CommandDecision,
  type CommandPart,
  type ShellGrammar,
  type SyntaxRefusal,
  type SyntaxRefusalReason,
} from "./policy.js";
export { posixSh } from "./posix.js";
export { simpleCommandProblem } from "./simple.js";
