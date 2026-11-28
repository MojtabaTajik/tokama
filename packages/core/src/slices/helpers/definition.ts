// What a helper is: its id and version, the inputs Tokama collects for it, its instructions and
// how long one call may take. The answer's shape is not here: it is part of the engine API
// (`HelperResultSchemas`), so a definition can never change it.
import { type AgentId, type HelperId, type HelperResult, HelperResultSchemas } from "../../kernel/schemas/index.js";

/**
 * The inputs a helper can ask for. Each has a plain-word label for the line that says what is
 * sent, and a size cap: an input over its cap is refused, never cut, because a cut file list or
 * build file would mislead the agent.
 */
export const HELPER_INPUTS = {
  "repo-file-names": { label: "file names", maxBytes: 16 * 1024 },
  "repo-build-files": { label: "build files", maxBytes: 80 * 1024 },
} as const;

export type HelperInputName = keyof typeof HELPER_INPUTS;

export const DEFAULT_HELPER_TIME_MS = 90_000;
export const MAX_HELPER_TIME_MS = 5 * 60_000;

export interface HelperDefinition {
  readonly id: HelperId;
  /** The content version: change it when the instructions change. Every usage record carries it. */
  readonly version: number;
  readonly name: string;
  /** In the order they appear in the prompt and in the line that says what is sent. */
  readonly inputs: readonly HelperInputName[];
  /** One call may take this long, at most `MAX_HELPER_TIME_MS`. */
  readonly maxTimeMs: number;
  /** The agent that answers. */
  readonly agentId: AgentId;
  readonly instructions: string;
  /**
   * One answer, shown to the agent as the shape to follow (a model asked for "JSON of this schema"
   * tends to answer with the schema). It must pass the shape and the helper's own rule.
   */
  readonly example: HelperResult;
  /**
   * What the answer's shape cannot say, e.g. that a command is one simple command. Returns what is
   * wrong, or undefined. The text goes back to the agent as a hint, so it must not repeat the answer.
   */
  readonly check?: (answer: HelperResult) => string | undefined;
  /**
   * Drops the parts of a valid answer that cannot be used, so the rest is still shown, before
   * `check` looks at it. Without it the answer is used as it came.
   */
  readonly normalize?: (answer: HelperResult) => HelperResult;
}

/** What is wrong with a definition, or undefined. A wrong one is a mistake in Tokama, not in a user file. */
export function definitionProblem(definition: HelperDefinition): string | undefined {
  const { id } = definition;
  if (!Number.isInteger(definition.version) || definition.version < 1) return `${id}: version must be a whole number from 1`;
  if (definition.name.trim() === "") return `${id}: name is empty`;
  if (definition.instructions.trim() === "") return `${id}: instructions are empty`;
  if (!Number.isInteger(definition.maxTimeMs) || definition.maxTimeMs < 1_000 || definition.maxTimeMs > MAX_HELPER_TIME_MS) {
    return `${id}: maxTimeMs must be from 1000 to ${MAX_HELPER_TIME_MS}`;
  }
  if (definition.inputs.length === 0) return `${id}: no inputs`;
  const unknown = definition.inputs.find((name) => !(name in HELPER_INPUTS));
  if (unknown !== undefined) return `${id}: unknown input ${unknown}`;
  if (new Set(definition.inputs).size !== definition.inputs.length) return `${id}: an input is listed twice`;
  if (!HelperResultSchemas[id].safeParse(definition.example).success) return `${id}: the example does not match the answer's shape`;
  const rule = definition.check?.(definition.example);
  if (rule !== undefined) return `${id}: the example breaks the helper's own rule`;
  return undefined;
}

/** The labels of a helper's inputs, as the line that says what is sent shows them. */
export const inputLabels = (definition: Pick<HelperDefinition, "inputs">): string[] => definition.inputs.map((name) => HELPER_INPUTS[name].label);
