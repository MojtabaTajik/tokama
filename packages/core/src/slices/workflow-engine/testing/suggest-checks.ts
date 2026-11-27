// A test-only definition of the suggest-checks helper for the runner's tests, while the engine's
// own list of helpers is still empty.
import type { AgentId, HelperResult } from "../../../kernel/schemas/index.js";
import type { HelperDefinition } from "../../helpers/index.js";

export const testSuggestChecks: HelperDefinition = {
  id: "suggest-checks",
  version: 3,
  name: "Suggest checks",
  inputs: ["repo-file-names", "repo-build-files"],
  maxTimeMs: 90_000,
  agentId: "helper" as AgentId,
  instructions: "Propose the commands that prove a change to this repository is correct.",
  example: { checks: [{ command: "pnpm test", why: "Runs the unit tests.", minutes: 5 }] },
  // A rule the answer's shape cannot say.
  check: (answer: HelperResult) => ("checks" in answer && answer.checks.some((check) => check.command.includes("&&")) ? "a check holds more than one command." : undefined),
};

export const GOOD_ANSWER = { checks: [{ command: "pnpm test", why: "Runs the unit tests.", minutes: 3 }] };
