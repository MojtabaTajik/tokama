// The question before a repo is removed, shared by the sidebar's repo menu and the Repos page in
// Settings. Removing only takes the repo out of repos.yaml; its items and worktrees are kept.
import { useId, useState } from "react";
import { DialogFrame, Modal, Problem } from "./Modal.js";

const TEXT = {
  question: (name: string) => `Remove ${name}?`,
  explain: "Tokama stops listing this repo. Its items and worktrees are kept, and nothing in the folder changes.",
  waiting: (count: number) => ` ${count} ${count === 1 ? "item waits" : "items wait"} for you in it.`,
  confirm: "Remove repo",
  removing: "Removing…",
  keep: "Keep",
  failed: (message: string) => `Could not remove it: ${message}`,
} as const;

export interface RemoveRepoDialogProps {
  readonly name: string;
  /** Items of this repo that wait for the user; named in the question. */
  readonly waiting?: number;
  /** Removes the repo; resolves to the engine's message when it refused. */
  readonly onRemove: () => Promise<string | undefined>;
  /** Called after "Keep" or Escape, and after the repo was removed. */
  readonly onClose: () => void;
}

export function RemoveRepoDialog({ name, waiting = 0, onRemove, onClose }: RemoveRepoDialogProps) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const refused = await onRemove().catch((cause: unknown) => String(cause));
    setBusy(false);
    if (refused === undefined) onClose();
    else setError(TEXT.failed(refused));
  };
  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <DialogFrame
        titleId={titleId}
        title={TEXT.question(name)}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="choice" autoFocus onClick={onClose}>
              {TEXT.keep}
            </button>
            <button type="button" className="choice danger" disabled={busy} onClick={() => void remove()}>
              {busy ? TEXT.removing : TEXT.confirm}
            </button>
          </>
        }
      >
        <p>
          {TEXT.explain}
          {waiting > 0 && TEXT.waiting(waiting)}
        </p>
        {error !== undefined && <Problem text={error} alert />}
      </DialogFrame>
    </Modal>
  );
}
