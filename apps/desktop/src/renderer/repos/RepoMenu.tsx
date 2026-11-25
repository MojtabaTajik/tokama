// The "⋯" menu on a repo row in the sidebar: Edit repo (opens its dialog) and Remove repo, after an
// in-app confirmation. Removing only takes the repo out of repos.yaml; its items and worktrees are kept.
// Keyboard: Enter, Space or ArrowDown opens the menu with its first item focused; Escape closes
// the menu or the confirmation and returns focus to the "⋯" button.
import { useEffect, useId, useRef, useState } from "react";
import { Modal, Problem } from "./Modal.js";

const TEXT = {
  actions: (name: string) => `Actions for ${name}`,
  edit: "Edit repo…",
  remove: "Remove repo…",
  question: (name: string) => `Remove ${name}?`,
  explain: "Tokama stops listing this repo. Its items and worktrees are kept, and nothing in the folder changes.",
  confirm: "Remove repo",
  removing: "Removing…",
  keep: "Keep",
  failed: (message: string) => `Could not remove it: ${message}`,
} as const;

export interface RepoMenuProps {
  readonly name: string;
  readonly onEdit: () => void;
  /** Removes the repo; resolves to the engine's message when it refused. */
  readonly onRemove: () => Promise<string | undefined>;
}

export function RepoMenu({ name, onEdit, onRemove }: RepoMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) firstItem.current?.focus();
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
    button.current?.focus();
  };
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const refused = await onRemove().catch((cause: unknown) => String(cause));
    setBusy(false);
    if (refused === undefined) setConfirming(false);
    else setError(TEXT.failed(refused));
  };

  return (
    <div
      className="repo-menu"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      }}
    >
      <button
        ref={button}
        type="button"
        className="sb-more"
        aria-label={TEXT.actions(name)}
        title={TEXT.actions(name)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="repo-menu-popup" role="menu" aria-label={TEXT.actions(name)}>
          <button
            ref={firstItem}
            type="button"
            role="menuitem"
            className="repo-menu-item"
            onClick={() => {
              closeMenu();
              onEdit();
            }}
          >
            {TEXT.edit}
          </button>
          <button
            type="button"
            role="menuitem"
            className="repo-menu-item"
            onClick={() => {
              closeMenu();
              setError(undefined);
              setConfirming(true);
            }}
          >
            {TEXT.remove}
          </button>
        </div>
      )}
      {confirming && (
        <Modal labelledBy={titleId} onClose={() => setConfirming(false)}>
          <div className="repo-form">
            <h2 id={titleId} className="modal-title">
              {TEXT.question(name)}
            </h2>
            <p>{TEXT.explain}</p>
            {error !== undefined && <Problem text={error} alert />}
            <div className="choices">
              <button type="button" className="choice danger" disabled={busy} onClick={() => void remove()}>
                {busy ? TEXT.removing : TEXT.confirm}
              </button>
              <button type="button" className="choice" autoFocus onClick={() => setConfirming(false)}>
                {TEXT.keep}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
