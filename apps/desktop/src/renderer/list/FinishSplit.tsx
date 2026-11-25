// The split button on a Done row: the main part merges into the base branch, ▾ opens a menu with
// all three ways to finish. Discard… opens the item with its question; nothing is thrown away from
// the list. Shown while the row is hovered or has focus; a sibling of the row's own button.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { type FocusEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
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
  readonly onFinish: (itemId: string, action: FinishAction) => void | Promise<void>;
  /** Opens the item with its Discard question. */
  readonly onDiscard: (itemId: string) => void;
}

export function FinishSplit({ item, setup, onFinish, onDiscard }: FinishSplitProps) {
  const [open, setOpen] = useState(false);
  // A command on its way: the buttons wait for its reply, so a double click sends one.
  const [sending, setSending] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const actions = finishActions(item);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !toggle.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
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
    // The split goes once the action starts: focus stays on the row.
    (toggle.current?.closest(".pl-row-wrap")?.querySelector(".pl-row") as HTMLElement | null)?.focus();
    if (action === "discard") return onDiscard(item.id);
    setSending(true);
    void Promise.resolve(onFinish(item.id, action)).finally(() => setSending(false));
  };
  // Focus that leaves the split closes the menu.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };
  // Arrow keys move between the menu's items; Escape closes it.
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div className="finish-split" data-open={open || undefined} onBlur={onBlur}>
      <button type="button" className="finish-split-main" disabled={sending} onClick={() => pick("merge")}>
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
        disabled={sending}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="finish-menu" role="menu" id={menuId} ref={menu} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => pick("merge")}>
            <span className="finish-menu-title">Merge into {base}</span>
            <span className="finish-menu-note">{TEXT.merge}</span>
          </button>
          {/* Off, but still reachable by the arrow keys, so its reason is read out. */}
          <button type="button" role="menuitem" tabIndex={-1} aria-disabled={off !== undefined || undefined} onClick={() => off === undefined && pick("pull_request")}>
            <span className="finish-menu-title">{TEXT.openPr}</span>
            <span className="finish-menu-note">{off ?? TEXT.pr}</span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="danger" onClick={() => pick("discard")}>
            <span className="finish-menu-title">{TEXT.discard}</span>
          </button>
        </div>
      )}
    </div>
  );
}
