// A decision's choice buttons, the same in the drawer and on the Needs you page: the first choice
// is the primary one, and every button is disabled while an answer is on its way. Request changes
// opens a note in place of the buttons: what the step's next run should change. The note is
// optional; Escape closes it, except while you type in it. A change approval shows its two answers
// only; its Stop stays in the drawer's actions, while any card that has Stop hides that one.
import type { Decision } from "@tokama/core";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "../ui/Button.js";

/** The engine's choice id for Request changes, the one choice that takes a note. */
export const REQUEST_CHANGES_ID = "request_changes";
/** The longest note the engine accepts. */
export const MAX_NOTE_CHARS = 2000;
/** Focus is in a field you type in, where Escape belongs to the field. */
export const inTextField = (target: EventTarget | null): boolean => target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null;

/** The engine's choice id for Approve. */
const APPROVE_ID = "approve";
/** The engine's choice id for Stop. */
const STOP_ID = "stop";

/** The choices a decision's card shows: a change approval shows its two answers only. */
const shownChoices = (decision: Decision) => (decision.hasDiff === true ? decision.choices.filter((choice) => choice.id === APPROVE_ID || choice.id === REQUEST_CHANGES_ID) : decision.choices);

/** The card of this decision has a Stop button, so the drawer's own Stop would be a second one. */
export const cardOffersStop = (decision: Decision): boolean => shownChoices(decision).some((choice) => choice.id === STOP_ID);

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
  /** The choice drawn as a danger button, e.g. Stop. */
  readonly danger?: string;
}

export function DecisionChoices({ decision, busy, onChoose, context, agent, run, extra, danger }: DecisionChoicesProps) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const hintId = useId();
  const named = (label: string) => (context === undefined ? undefined : `${label}: ${context}`);
  const choices = shownChoices(decision);

  // Escape closes the note before anything else handles it (the drawer, the full view).
  useEffect(() => {
    if (!noting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || inTextField(event.target)) return;
      event.preventDefault();
      setNoting(false);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [noting]);

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
          <Button variant="primary" type="submit" disabled={busy} aria-label={named(TEXT.send(agent))}>
            {TEXT.send(agent)}
          </Button>
          <Button variant="secondary" onClick={() => setNoting(false)}>
            {TEXT.cancel}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="choices">
      {choices.map((choice, position) => (
        <Button
          key={choice.id}
          variant={position === 0 ? "primary" : choice.id === danger ? "danger" : "secondary"}
          disabled={busy}
          aria-label={named(choice.label)}
          onClick={() => (choice.id === REQUEST_CHANGES_ID ? setNoting(true) : onChoose(choice.id))}
        >
          {choice.label}
        </Button>
      ))}
      {extra}
    </div>
  );
}
