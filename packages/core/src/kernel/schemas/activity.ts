// The live activity of a running item: what its agent (or Tokama, while it runs the checks) is
// doing now. The engine keeps it in memory and pushes it to clients; it is never stored. The
// labels are words the engine derived from the agent's tool calls, with paths outside the
// worktree left out; clients show them as text only.
import { z } from "zod";
import { EpochMsSchema, ItemIdSchema } from "./ids.js";

/** The longest activity label, in characters. */
export const MAX_ACTIVITY_LABEL_CHARS = 200;
/** No agent event for this long, with no tool running, reads as quiet. */
export const QUIET_AFTER_MS = 120_000;

/** What the latest action does: read files, edit them, run a command, think (or write), or anything else. */
export const ActivityKindSchema = z.enum(["read", "edit", "run", "think", "other"]);

const label = z.string().min(1).max(MAX_ACTIVITY_LABEL_CHARS);

export const ItemActivitySchema = z.strictObject({
  itemId: ItemIdSchema,
  /** The running step, by index as the item record lists steps. */
  stepIndex: z.int().nonnegative().max(1000),
  attempt: z.int().min(1).max(10_000),
  /** Who works: the step's agent, or Tokama while it runs the setup and checks. */
  by: z.enum(["agent", "tokama"]),
  /** The latest action, e.g. `{ kind: "edit", label: "editing src/board.ts" }`. */
  lastAction: z.strictObject({ kind: ActivityKindSchema, label }),
  /** When the agent last sent an event (UTC epoch ms). */
  lastEventAt: EpochMsSchema,
  /** A tool call or command that started and has no result yet, with its own start time. */
  toolRunning: z.strictObject({ label, startedAt: EpochMsSchema }).nullable(),
});

export type ActivityKind = z.output<typeof ActivityKindSchema>;
export type ItemActivity = z.output<typeof ItemActivitySchema>;

/**
 * How long the agent has been quiet at `now`: no event for `afterMs` or more while no tool runs.
 * Undefined when it is not quiet: a long test run sends nothing and is still work.
 */
export function quietForMs(activity: Pick<ItemActivity, "lastEventAt" | "toolRunning">, now: number, afterMs = QUIET_AFTER_MS): number | undefined {
  if (activity.toolRunning !== null) return undefined;
  const quiet = now - activity.lastEventAt;
  return quiet >= afterMs ? quiet : undefined;
}
