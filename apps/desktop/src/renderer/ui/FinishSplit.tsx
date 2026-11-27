// The split button that finishes a done item's work: the main part merges into the base branch (or
// says what to do after a refusal), ▾ opens a menu with all three ways to finish. Discard… only
// asks; nothing is thrown away from the button. `row` is the small button of a list row, shown
// while the row is hovered or has focus, a sibling of the row's own button; `filled` is the item's
// one Finish button, always visible.
import type { FinishAction } from "@tokama/core";
import { type FocusEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button.js";

const TEXT = {
  merge: "local merge, then clean up",
  pr: "push and open with gh",
  openPr: "Open PR",
  discard: "Discard…",
} as const;

/** What a pick sends: a way to finish, or the engineer saying they made the listed git changes. */
export type FinishPick = FinishAction | "accept_git_changes";

export interface FinishSplitProps {
  readonly variant: "row" | "filled";
  /** The base branch: "main". */
  readonly base: string;
  /** Why Open PR is off; undefined when it can run. */
  readonly prOff: string | undefined;
  /** For screen readers: what the arrow opens. */
  readonly moreLabel: string;
  /** What the main part says and does when it is not Merge: a retry, or taking the git changes. */
  readonly main?: { readonly label: string; readonly action: FinishPick; readonly disabled?: boolean | undefined } | undefined;
  readonly disabled?: boolean | undefined;
  /** Runs a pick; the split waits for its promise before it can be used again (Discard… only asks, so it does not wait). */
  readonly onPick: (pick: FinishPick) => void | Promise<void>;
  /** A pick goes ahead, before it runs; `from` is the arrow button, for moving focus to where the split goes away. */
  readonly onPicked?: ((from: HTMLElement | null) => void) | undefined;
}

export function FinishSplit({ variant, base, prOff, moreLabel, main, disabled = false, onPick, onPicked }: FinishSplitProps) {
  const [open, setOpen] = useState(false);
  // A command on its way: the buttons wait for its reply, so a double click sends one.
  const [sending, setSending] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const off = disabled || sending;
  const mainPick = main ?? { label: `Merge into ${base}`, action: "merge" as const, disabled: false };

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

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  const pick = (action: FinishPick) => {
    setOpen(false);
    onPicked?.(toggle.current);
    if (action === "discard") return void onPick(action);
    setSending(true);
    void Promise.resolve(onPick(action)).finally(() => setSending(false));
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
    <div className="finish-split" data-variant={variant} data-open={open || undefined} onBlur={onBlur}>
      <Button variant="plain" className="finish-split-main" disabled={off || mainPick.disabled === true} onClick={() => pick(mainPick.action)}>
        {mainPick.label}
      </Button>
      <Button
        variant="plain"
        className="finish-split-more"
        ref={toggle}
        aria-label={moreLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={off}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">▾</span>
      </Button>
      {open && (
        <div className="finish-menu" role="menu" id={menuId} ref={menu} onKeyDown={onMenuKey}>
          <Button variant="plain" role="menuitem" tabIndex={-1} onClick={() => pick("merge")}>
            <span className="finish-menu-title">Merge into {base}</span>
            <span className="finish-menu-note">{TEXT.merge}</span>
          </Button>
          {/* Off, but still reachable by the arrow keys, so its reason is read out. */}
          <Button variant="plain" role="menuitem" tabIndex={-1} aria-disabled={prOff !== undefined || undefined} onClick={() => prOff === undefined && pick("pull_request")}>
            <span className="finish-menu-title">{TEXT.openPr}</span>
            <span className="finish-menu-note">{prOff ?? TEXT.pr}</span>
          </Button>
          <Button variant="plain" role="menuitem" tabIndex={-1} className="danger" onClick={() => pick("discard")}>
            <span className="finish-menu-title">{TEXT.discard}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
