// What an item's agent said about its work, for the one line a done row, a card or a banner
// shows. Type imports only: the renderer and the main process both use this file.
import type { ItemRecord, Said, StepRecord } from "@tokama/core";

/** What the agent said, and where: the step and the attempt of the agent that said it. */
export interface ItemSaid {
  readonly said: Said;
  readonly stepIndex: number;
  readonly attempt: number;
}

const isReviewer = (step: Pick<StepRecord, "doneWhen">): boolean => step.doneWhen === "reviewer approves";

/** The latest attempt of the step that has something said, or undefined. */
function latestSaid(step: Pick<StepRecord, "attempts">): { said: Said; attempt: number } | undefined {
  const found = step.attempts?.findLast((attempt) => attempt.said !== undefined);
  return found?.said === undefined ? undefined : { said: found.said, attempt: found.attempt };
}

/**
 * The words the item is known by: those of the last step that passed and is not a reviewer's
 * (the worker said what was done; the reviewer judged it), else those of the last step that said
 * anything. Undefined when no step said anything, as for an item from before this existed.
 */
export function saidOf(item: Pick<ItemRecord, "steps">): ItemSaid | undefined {
  const pick = (accept: (step: StepRecord) => boolean): ItemSaid | undefined => {
    for (let stepIndex = item.steps.length - 1; stepIndex >= 0; stepIndex--) {
      const step = item.steps[stepIndex]!;
      if (!accept(step)) continue;
      const found = latestSaid(step);
      if (found !== undefined) return { ...found, stepIndex };
    }
    return undefined;
  };
  return pick((step) => step.state === "passed" && !isReviewer(step)) ?? pick(() => true);
}

/** The tag of a must-read: "read · 6 min". */
export const readTag = (said: Said): string | undefined => (said.readMinutes === undefined ? undefined : `read · ${said.readMinutes} min`);

/**
 * The tag that follows a headline on a row: the read time of a must-read, else "+3 points" when
 * the agent wrote points. The lines that follow the first line of a reply with no headline are
 * not points: they have no tag.
 */
export function saidTag(said: Said): string | undefined {
  const read = readTag(said);
  if (read !== undefined || said.source !== "headline") return read;
  const count = said.points.length + said.morePoints;
  return count === 0 ? undefined : `+${count} ${count === 1 ? "point" : "points"}`;
}
