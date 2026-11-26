// The card shown once after an update to a version with highlights. It sits at the foot of the
// sidebar, never over the board or the drawer, and takes no focus. Got it, See all and Escape
// (while focus is inside it) all close it for good; See all also opens About on this version.
import { useId } from "react";
import type { Note } from "../../shared/whats-new.js";
import { Button } from "../ui/Button.js";
import { NoteBody } from "./NoteBody.js";
import { TEXT } from "./words.js";

export interface WhatsNewCardProps {
  readonly note: Note;
  /** Closes the card for good. */
  readonly onGotIt: () => void;
  /** Closes the card for good and opens About on this version. */
  readonly onSeeAll: () => void;
}

export function WhatsNewCard({ note, onGotIt, onSeeAll }: WhatsNewCardProps) {
  const titleId = useId();
  return (
    <section
      className="wn-card rise-in"
      role="region"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape here is for the card alone: it must not also close the drawer.
        event.preventDefault();
        event.stopPropagation();
        onGotIt();
      }}
    >
      <div className="wn-card-head">
        <span className="wn-eyebrow">
          {TEXT.eyebrow} · <span className="mono">{note.version}</span>
        </span>
        <h3 id={titleId} className="wn-card-title">
          {TEXT.cardTitle}
        </h3>
      </div>
      <div className="wn-card-body">
        <NoteBody note={note} />
      </div>
      <div className="wn-card-actions">
        <Button onClick={onSeeAll}>{TEXT.seeAll}</Button>
        <Button variant="primary" onClick={onGotIt}>
          {TEXT.gotIt}
        </Button>
      </div>
    </section>
  );
}
