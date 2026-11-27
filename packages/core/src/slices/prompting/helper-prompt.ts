// Builds what one helper call receives: the rules, the helper's instructions, the shape of the
// answer, and each input in a data block. It checks the local-only rule and the size limits a
// second time, at the last point before anything is sent. Never throws: every problem is a refusal.
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { AgentId } from "../../kernel/schemas/index.js";
import { chooseMark, fence, randomMark } from "./fence.js";
import { HELPER_RULES } from "./rules.js";
import { type PromptAgent, runsInCloud } from "./build-prompt.js";

/** What every helper input together may be. Larger is refused, never cut. */
export const HELPER_PROMPT_LIMITS = { totalBytes: 96 * 1024 } as const;

export interface HelperPromptInput {
  /** The helper's instructions: Tokama's own text, not untrusted. */
  readonly instructions: string;
  /** The answer's JSON Schema, shown to the agent. */
  readonly answerShape: unknown;
  /** Each input in order. `maxBytes` is the cap of that input. */
  readonly inputs: readonly { readonly name: string; readonly text: string; readonly maxBytes: number }[];
  readonly agent: PromptAgent;
  /** Local-only mode: a cloud agent is refused. */
  readonly localOnly?: boolean;
  /** For a second try: what was wrong with the first answer (from `retryNote`). */
  readonly retryNote?: string;
  /** Draws the data-block mark. Default: 16 random bytes in hex. */
  readonly drawMark?: () => string;
}

export type HelperPromptRefusalCode = "local-only" | "too-large" | "mark";

export interface HelperPromptRefusal {
  readonly code: HelperPromptRefusalCode;
  readonly message: string;
}

/** What went into the call, for the helper's record: names and sizes only, never the text. */
export interface HelperPromptRecord {
  readonly agentId: AgentId;
  /** The prompt left the machine: the agent runs in the cloud. */
  readonly sentToCloud: boolean;
  readonly included: readonly { readonly name: string; readonly bytes: number }[];
}

export interface BuiltHelperPrompt {
  /** Goes to the CLI's system prompt. Holds no untrusted content. */
  readonly system: string;
  readonly user: string;
  readonly record: HelperPromptRecord;
}

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

export function buildHelperPrompt(input: HelperPromptInput): Result<BuiltHelperPrompt, HelperPromptRefusal> {
  const { agent } = input;
  const cloud = runsInCloud(agent.cliId);
  if (cloud && input.localOnly === true) return err({ code: "local-only", message: `Agent ${JSON.stringify(agent.id)} runs in the cloud, and local-only mode is on.` });

  const sizes = input.inputs.map((item) => bytesOf(item.text));
  const over = input.inputs.findIndex((item, index) => sizes[index]! > item.maxBytes);
  if (over !== -1) return err({ code: "too-large", message: `The ${input.inputs[over]!.name} input is ${sizes[over]} bytes, over its ${input.inputs[over]!.maxBytes}-byte limit.` });
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > HELPER_PROMPT_LIMITS.totalBytes) return err({ code: "too-large", message: `The inputs are ${total} bytes together, over the ${HELPER_PROMPT_LIMITS.totalBytes}-byte limit.` });

  const mark = chooseMark(
    input.inputs.flatMap((item) => [item.name, item.text]),
    input.drawMark ?? randomMark,
  );
  if (!mark.ok) return err({ code: "mark", message: mark.error });

  const role = agent.role.trim();
  const system = role === "" ? HELPER_RULES : `${HELPER_RULES}\n\n${role}`;
  const user =
    [
      `Data blocks in this message use the mark ${mark.value}.`,
      input.instructions.trim(),
      `Answer with one JSON object of this shape (JSON Schema):\n${JSON.stringify(input.answerShape, null, 2)}`,
      ...input.inputs.map((item) => fence(item.name, item.text, mark.value)),
      ...(input.retryNote === undefined ? [] : [input.retryNote]),
    ].join("\n\n") + "\n";
  return ok({ system, user, record: { agentId: agent.id, sentToCloud: cloud, included: input.inputs.map((item, index) => ({ name: item.name, bytes: sizes[index]! })) } });
}
