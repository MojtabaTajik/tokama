// A decision's choice buttons, the same in the drawer and on the Needs you page: the first choice
// is the primary one, and every button is disabled while an answer is on its way. Request changes
// first opens a note: what the step's next attempt should change. The note is optional.
import type { Decision } from "@tokama/core";
import { useId, useState } from "react";

/** The engine's choice id for Request changes, the one choice that takes a note. */
export const REQUEST_CHANGES_ID = "request_changes";
/** The longest note the engine accepts. */
export const MAX_NOTE_CHARS = 2000;

const TEXT = {
  note: "What should change?",
  send: "Send and run again",
  cancel: "Cancel",
} as const;

export interface DecisionChoicesProps {
  readonly decision: Decision;
  readonly busy: boolean;
  readonly onChoose: (choiceId: string, note?: string) => void;
  /** Names the item in each button's accessible name, where several items' buttons share a page. */
  readonly context?: string;
}

export function DecisionChoices({ decision, busy, onChoose, context }: DecisionChoicesProps) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const named = (label: string) => (context === undefined ? undefined : `${label}: ${context}`);

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
        <textarea id={noteId} className="decision-note-text" rows={3} maxLength={MAX_NOTE_CHARS} value={note} autoFocus onChange={(event) => setNote(event.target.value)} />
        <div className="choices">
          <button type="submit" className="choice primary" disabled={busy} aria-label={named(TEXT.send)}>
            {TEXT.send}
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
      {decision.choices.map((choice, position) => (
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
    </div>
  );
}
