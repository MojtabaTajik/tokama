// What the "While you were away" strip lists, as pure functions over the item records: which open
// items count as news since `seenUntil`, how the groups are capped, and the words of one line.
// The strip writes no text of its own: a line is the item's own question, headline, facts or card line.
import type { ItemRecord } from "@tokama/core";
import { type Fact, factsOf } from "../../shared/item-facts.js";
import { saidOf } from "../../shared/item-said.js";

/** The most lines each group shows; the rest are counted as "and N more". */
export const AWAY_LINES = 5;

export interface AwayGroup {
  /** The first lines of the group. */
  readonly shown: readonly ItemRecord[];
  /** Every item of the group, shown or not. */
  readonly count: number;
}

/** One page of finished items as the engine listed them: the rows and the count of all that match. */
export interface AwayPage {
  readonly items: readonly ItemRecord[];
  readonly total: number | undefined;
}

export interface AwayModel {
  /** Questions asked since `seenUntil`, oldest first. */
  readonly needs: AwayGroup;
  /** Items that ended well since `seenUntil`; an item the user stopped is not news. */
  readonly finished: AwayGroup;
  readonly failed: AwayGroup;
  /** Items running now, in board order. */
  readonly running: AwayGroup;
  /** Whether anything asked, finished or failed: with none there is no strip. */
  readonly news: boolean;
}

const group = (items: readonly ItemRecord[], count = items.length): AwayGroup => ({ shown: items.slice(0, AWAY_LINES), count });

const askedAt = (item: ItemRecord): number => item.decision?.askedAt ?? 0;

export function awayModel(input: { readonly seenUntil: number; readonly open: readonly ItemRecord[]; readonly done: AwayPage | undefined; readonly failed: AwayPage | undefined }): AwayModel {
  const { seenUntil, open, done, failed } = input;
  const asking = open
    .filter((item) => item.state === "needs_you" && askedAt(item) > seenUntil)
    .sort((a, b) => askedAt(a) - askedAt(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // The engine's done group holds stopped items too; the count leaves out those on the page.
  const ended = (done?.items ?? []).filter((item) => item.state === "done");
  const stopped = (done?.items.length ?? 0) - ended.length;
  const finished = group(ended, Math.max(0, (done?.total ?? 0) - stopped));
  const failedGroup = group(failed?.items ?? [], failed?.total ?? 0);
  const needs = group(asking);
  return { needs, finished, failed: failedGroup, running: group(open.filter((item) => item.state === "running")), news: needs.count + finished.count + failedGroup.count > 0 };
}

/** The words of one line: text and facts, either may be missing, never both. */
export interface AwayLine {
  readonly text: string | undefined;
  readonly facts: readonly Fact[];
}

/**
 * What a line says. A question line is the question with the headline of what the agent said
 * before it; a finished line is the headline over the facts; a failed line is its facts; an item
 * with none of these says its card line.
 */
export function awayLine(item: ItemRecord): AwayLine {
  const headline = saidOf(item)?.said.headline;
  if (item.state === "needs_you") return { text: [item.decision?.question, headline].filter((part) => part !== undefined).join(" ") || item.cardLine, facts: [] };
  const facts = factsOf(item);
  // A failed item keeps its facts where an agent's headline would be; the headline stands in only when it has no facts.
  const text = item.state === "done" || facts.length === 0 ? headline : undefined;
  return text === undefined && facts.length === 0 ? { text: item.cardLine, facts } : { text, facts };
}
