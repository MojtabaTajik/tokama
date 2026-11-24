// kernel/command-policy: decide whether a check or step command may run, with one grammar per
// shell (POSIX `sh` now, PowerShell later). A guardrail, not a full shell parser.
// See docs/spec/architecture.md, sections 6 and 9, and docs/spec/product.md, section 8.
export {
  PIPE_HELPERS,
  checkCommand,
  type CommandDecision,
  type CommandPart,
  type ShellGrammar,
  type SyntaxRefusal,
  type SyntaxRefusalReason,
} from "./policy.js";
export { posixSh } from "./posix.js";
