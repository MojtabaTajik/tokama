// The split button on a Done row: the main part merges into the base branch, ▾ opens a menu with
// all three ways to finish. Discard… opens the item with its question; nothing is thrown away from
// the list. Shown while the row is hovered or has focus; a sibling of the row's own button.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { baseBranchOf, finishActions, prUnavailable } from "../drawer/finish-view.js";

const TEXT = {
  more: (title: string) => `More ways to finish ${title}`,
  merge: "local merge, then clean up",
  pr: "push and open with gh",
  openPr: "Open PR",
  discard: "Discard…",
} as const;

export interface FinishSplitProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly onFinish: (itemId: string, action: FinishAction) => void;
  /** Opens the item with its Discard question. */
  readonly onDiscard: (itemId: string) => void;
}

export function FinishSplit({ item, setup, onFinish, onDiscard }: FinishSplitProps) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const actions = finishActions(item);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && event.target !== toggle.current) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!actions.includes("merge")) return null;
  const base = baseBranchOf(item, setup);
  const off = prUnavailable(item, setup);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  const pick = (action: FinishAction) => {
    setOpen(false);
    if (action === "discard") onDiscard(item.id);
    else onFinish(item.id, action);
  };
  // Arrow keys move between the menu's items; Escape closes it.
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <div className="finish-split" data-open={open || undefined}>
      <button type="button" className="finish-split-main" onClick={() => pick("merge")}>
        Merge into {base}
      </button>
      <button
        type="button"
        className="finish-split-more"
        ref={toggle}
        aria-label={TEXT.more(item.title)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="finish-menu" role="menu" id={menuId} ref={menu} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" onClick={() => pick("merge")}>
            <span className="finish-menu-title">Merge into {base}</span>
            <span className="finish-menu-note">{TEXT.merge}</span>
          </button>
          <button type="button" role="menuitem" disabled={off !== undefined} title={off} onClick={() => pick("pull_request")}>
            <span className="finish-menu-title">{TEXT.openPr}</span>
            <span className="finish-menu-note">{off ?? TEXT.pr}</span>
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => pick("discard")}>
            <span className="finish-menu-title">{TEXT.discard}</span>
          </button>
        </div>
      )}
    </div>
  );
}
