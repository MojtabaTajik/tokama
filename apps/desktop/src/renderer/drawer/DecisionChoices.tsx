// A decision's choice buttons, the same in the drawer and on the Needs you page: the first choice
// is the primary one, and every button is disabled while an answer is on its way. Request changes
// opens a note in place of the buttons: what the step's next run should change. The note is
// optional. A change approval shows its two answers only; Stop stays in the drawer's actions.
import type { Decision } from "@tokama/core";
import { type ReactNode, useId, useState } from "react";

/** The engine's choice id for Request changes, the one choice that takes a note. */
export const REQUEST_CHANGES_ID = "request_changes";
/** The longest note the engine accepts. */
export const MAX_NOTE_CHARS = 2000;
/** The engine's choice id for Approve. */
const APPROVE_ID = "approve";

const TEXT = {
  note: "What should change?",
  hint: (agent: string | undefined, run: string | undefined) => `Goes into ${agent === undefined ? "the step" : `${agent}'s`} next run with the current diff.${run === undefined ? "" : ` ${run}.`}`,
  send: (agent: string | undefined) => (agent === undefined ? "Send and run again" : `Send to ${agent}`),
  cancel: "Cancel",
} as const;

export interface DecisionChoicesProps {
  readonly decision: Decision;
  readonly busy: boolean;
  readonly onChoose: (choiceId: string, note?: string) => void;
  /** Names the item in each button's accessible name, where several items' buttons share a page. */
  readonly context?: string;
  /** The agent the note goes to, by name. */
  readonly agent?: string | undefined;
  /** "Run 2 of 3": the run Request changes starts. */
  readonly run?: string | undefined;
  /** Shown at the end of the buttons' row, e.g. "Review the diff". */
  readonly extra?: ReactNode;
}

export function DecisionChoices({ decision, busy, onChoose, context, agent, run, extra }: DecisionChoicesProps) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const hintId = useId();
  const named = (label: string) => (context === undefined ? undefined : `${label}: ${context}`);
  const choices = decision.hasDiff === true ? decision.choices.filter((choice) => choice.id === APPROVE_ID || choice.id === REQUEST_CHANGES_ID) : decision.choices;

  if (noting) {
    return (
      <form
        className="decision-note"
        onSubmit={(event) => {
          event.preventDefault();
          onChoose(REQUEST_CHANGES_ID, note.trim() === "" ? undefined : note.trim());
        }}
      >
        <label htmlFor={noteId}>{TEXT.note}</label>
        <textarea
          id={noteId}
          className="decision-note-text"
          rows={3}
          maxLength={MAX_NOTE_CHARS}
          value={note}
          autoFocus
          aria-describedby={hintId}
          onChange={(event) => setNote(event.target.value)}
        />
        <span id={hintId} className="decision-note-hint">
          {TEXT.hint(agent, run)}
        </span>
        <div className="choices">
          <button type="submit" className="choice primary" disabled={busy} aria-label={named(TEXT.send(agent))}>
            {TEXT.send(agent)}
          </button>
          <button type="button" className="choice" onClick={() => setNoting(false)}>
            {TEXT.cancel}
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="choices">
      {choices.map((choice, position) => (
        <button
          key={choice.id}
          type="button"
          className={position === 0 ? "choice primary" : "choice"}
          disabled={busy}
          aria-label={named(choice.label)}
          onClick={() => (choice.id === REQUEST_CHANGES_ID ? setNoting(true) : onChoose(choice.id))}
        >
          {choice.label}
        </button>
      ))}
      {extra}
    </div>
  );
}
