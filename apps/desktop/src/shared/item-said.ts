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

/** What the step's last attempt said: of a passed step, the attempt that passed; an earlier attempt's words describe work that was not kept. */
function lastSaid(step: Pick<StepRecord, "attempts">): { said: Said; attempt: number } | undefined {
  const last = step.attempts?.at(-1);
  return last?.said === undefined ? undefined : { said: last.said, attempt: last.attempt };
}

/** The latest attempt of the step that said something, for a step that did not pass. */
function latestSaid(step: Pick<StepRecord, "attempts">): { said: Said; attempt: number } | undefined {
  const found = step.attempts?.findLast((attempt) => attempt.said !== undefined);
  return found?.said === undefined ? undefined : { said: found.said, attempt: found.attempt };
}

/**
 * The words the item is known by: those of the last step that passed and is not a reviewer's
 * (the worker said what was done; the reviewer judged it), from its last attempt only, else those
 * of the last step that said anything. Undefined when no step said anything, as for an item from
 * before this existed.
 */
export function saidOf(item: Pick<ItemRecord, "steps"> & Partial<Pick<ItemRecord, "outcome">>): ItemSaid | undefined {
  const answered = noChangeSaidOf(item);
  if (answered !== undefined) return answered;
  const pick = (accept: (step: StepRecord) => boolean, find: typeof lastSaid): ItemSaid | undefined => {
    for (let stepIndex = item.steps.length - 1; stepIndex >= 0; stepIndex--) {
      const step = item.steps[stepIndex]!;
      if (!accept(step)) continue;
      const found = find(step);
      if (found !== undefined) return { ...found, stepIndex };
    }
    return undefined;
  };
  const worked = (step: StepRecord) => step.state === "passed" && !isReviewer(step);
  return pick(worked, lastSaid) ?? pick((step) => !worked(step), latestSaid);
}

/**
 * For an item that ended with no action needed: the words of the step whose answer said no change
 * is needed, whichever step that is (an earlier step may have passed). The flag is set only when
 * the engine offered it and the step changed nothing.
 */
function noChangeSaidOf(item: Pick<ItemRecord, "steps"> & Partial<Pick<ItemRecord, "outcome">>): ItemSaid | undefined {
  if (item.outcome?.kind !== "no_action_needed") return undefined;
  for (let stepIndex = item.steps.length - 1; stepIndex >= 0; stepIndex--) {
    const found = lastSaid(item.steps[stepIndex]!);
    if (found?.said.noChange === true) return { ...found, stepIndex };
  }
  return undefined;
}

/** The item ended on the answer of a step you approve, and its agent said no change is needed: the answer is the result. */
export const answeredNoChange = (item: Pick<ItemRecord, "outcome" | "steps">): boolean => noChangeSaidOf(item) !== undefined;

/** "no change needed · ended at Plan, step 1 of 3" for such an item, so its row says why it did not go on. */
export function noChangeLine(item: Pick<ItemRecord, "outcome" | "steps">): string | undefined {
  const found = noChangeSaidOf(item);
  const step = found === undefined ? undefined : item.steps[found.stepIndex];
  return found === undefined || step === undefined ? undefined : `no change needed · ended at ${step.name}, step ${found.stepIndex + 1} of ${item.steps.length}`;
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
