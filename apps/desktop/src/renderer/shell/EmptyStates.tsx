// The screen that stands in for the list when a view has no work. First launch is the Get started
// checklist (getstarted/GetStarted.tsx). All text is fixed app text; nothing from the engine is shown here.
import { EmptyState } from "../ui/EmptyState.js";

const TEXT = {
  noWork: "No work yet",
  noWorkHint: "Describe a task or paste an alert below. It starts in the template you pick.",
} as const;

export function NoWork() {
  return (
    <EmptyState className="state" title={TEXT.noWork} text={TEXT.noWorkHint} />
  );
}
