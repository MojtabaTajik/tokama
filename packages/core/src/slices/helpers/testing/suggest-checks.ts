// A test-only definition of the suggest-checks helper, so tests can run a helper while the
// engine's own list is still empty.
import { type AgentId, type HelperResult } from "../../../kernel/schemas/index.js";
import type { HelperDefinition } from "../definition.js";

/** A rule the shape cannot say: a command may not hold `&&`. */
export const noAndAnd = (answer: HelperResult): string | undefined =>
  "checks" in answer && answer.checks.some((check) => check.command.includes("&&")) ? "a check holds more than one command." : undefined;

export const testSuggestChecks: HelperDefinition = {
  id: "suggest-checks",
  version: 3,
  name: "Suggest checks",
  inputs: ["repo-file-names", "repo-build-files"],
  maxTimeMs: 90_000,
  agentId: "helper" as AgentId,
  instructions: "Propose the commands that prove a change to this repository is correct.",
  check: noAndAnd,
};

export const GOOD_ANSWER = { checks: [{ command: "pnpm test", why: "Runs the unit tests.", minutes: 3 }] };
