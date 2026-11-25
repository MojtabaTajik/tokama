// A decision's choice buttons, the same in the drawer and on the Needs you page: the first choice
// is the primary one, and every button is disabled while an answer is on its way.
import type { Decision } from "@tokama/core";

export interface DecisionChoicesProps {
  readonly decision: Decision;
  readonly busy: boolean;
  readonly onChoose: (choiceId: string) => void;
  /** Names the item in each button's accessible name, where several items' buttons share a page. */
  readonly context?: string;
}

export function DecisionChoices({ decision, busy, onChoose, context }: DecisionChoicesProps) {
  return (
    <div className="choices">
      {decision.choices.map((choice, position) => (
        <button
          key={choice.id}
          type="button"
          className={position === 0 ? "choice primary" : "choice"}
          disabled={busy}
          aria-label={context === undefined ? undefined : `${choice.label}: ${context}`}
          onClick={() => onChoose(choice.id)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
