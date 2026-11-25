// The note that stays on the board after Tokama set git up in a folder and added it as a repo:
// what it did, and a way to start the first task there. Dismissed with ✕.
import type { SetUpNote } from "./RepoDialog.js";

const TEXT = {
  added: (id: string) => `Added ${id}`,
  setUp: "git set up · first commit",
  files: (count: number) => ` · ${count} ${count === 1 ? "file" : "files"}`,
  start: "Start a quick task",
  dismiss: "Dismiss",
} as const;

export interface RepoNoteProps {
  readonly note: SetUpNote;
  readonly onStart: () => void;
  readonly onDismiss: () => void;
}

export function RepoNote({ note, onStart, onDismiss }: RepoNoteProps) {
  return (
    <div className="repo-setup-note" role="status">
      <span className="rd-pass" aria-hidden="true">
        ✓
      </span>
      <b>{TEXT.added(note.id)}</b>
      <span className="rd-dim">
        {TEXT.setUp} <span className="mono">{note.commit}</span>
        {note.files > 0 && TEXT.files(note.files)}
      </span>
      <button type="button" className="rd-link" onClick={onStart}>
        {TEXT.start}
      </button>
      <button type="button" className="dlg-close" aria-label={TEXT.dismiss} onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
