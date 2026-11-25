// The note that stays on the board after Tokama set git up in a folder and added it as a repo:
// what it did, and a way to start the first task there. Dismissed with ✕.
import type { SetUpNote } from "./RepoDialog.js";
import { Button, CloseButton } from "../ui/Button.js";
import { markOf } from "../ui/status.js";

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
        {markOf("passed").symbol}
      </span>
      <b>{TEXT.added(note.id)}</b>
      <span className="rd-dim">
        {TEXT.setUp} <span className="mono">{note.commit}</span>
        {note.files > 0 && TEXT.files(note.files)}
      </span>
      <Button variant="link" className="rd-link" onClick={onStart}>
        {TEXT.start}
      </Button>
      <CloseButton className="dlg-close" label={TEXT.dismiss} onClick={onDismiss} />
    </div>
  );
}
