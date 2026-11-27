// What choosing the first answer of a "no change needed" question does, in words: the item ends
// as done and the steps after the question do not run, and nothing was changed or committed.
// Shown on the question's card in the drawer and on the Needs you page. Engine text (step names)
// is rendered as React text only.
import type { Decision, ItemRecord } from "@tokama/core";

const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

const TEXT = {
  label: "What finishing does",
  then: "Then",
  changes: "Changes",
  none: "none · 0 files changed, nothing is committed",
  ends: (later: readonly string[]) => (later.length === 0 ? "The item ends as done" : `The item ends as done · ${list.format(later)} ${later.length === 1 ? "does" : "do"} not run`),
} as const;

export function NoChangeFacts({ item, decision }: { readonly item: Pick<ItemRecord, "steps">; readonly decision: Pick<Decision, "stepIndex" | "proposes"> }) {
  if (decision.proposes !== "no_change") return null;
  const later = item.steps.slice(decision.stepIndex + 1).map((step) => step.name);
  return (
    <dl className="rc-facts" aria-label={TEXT.label}>
      <div className="rc-row">
        <dt>{TEXT.then}</dt>
        <dd>{TEXT.ends(later)}</dd>
      </div>
      <div className="rc-row">
        <dt>{TEXT.changes}</dt>
        <dd>{TEXT.none}</dd>
      </div>
    </dl>
  );
}
