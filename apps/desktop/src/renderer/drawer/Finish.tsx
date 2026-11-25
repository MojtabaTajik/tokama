// The drawer's Finish section for a done item: what was done with its worktree, the actions on
// offer (Merge into the base branch, Open PR, Discard), and an in-app confirmation before Discard.
// Each action is a change outside the worktree that the engine runs on this click; its result
// comes back as item updates. Engine and repo text (URLs, branch names, git's words) is text only.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { useEffect, useRef, useState } from "react";
import { finishView } from "./finish-view.js";

const TEXT = {
  finish: "Finish",
  discardQuestion: "Discard this item's worktree and branch? Work that is not merged or pushed is lost.",
  discardConfirm: "Discard",
  discardCancel: "Keep",
} as const;

export interface FinishProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly busy: boolean;
  readonly onFinish: (action: FinishAction) => void;
}

export function Finish({ item, setup, busy, onFinish }: FinishProps) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const view = finishView(item, setup);

  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  // Escape closes the confirmation first; the drawer closes only on the next Escape.
  useEffect(() => {
    if (!confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setConfirming(false);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [confirming]);

  if (view === undefined) return null;
  return (
    <section className="finish" aria-label={TEXT.finish}>
      <p className="finish-heading">{TEXT.finish}</p>
      {view.lines.map((line, index) => (
        <p key={index} className="finish-line">
          <span className="mark" data-tone={line.mark.tone} aria-hidden="true">
            {line.mark.symbol}
          </span>
          <span className="visually-hidden">{line.mark.word}: </span>
          {line.text}
        </p>
      ))}
      {view.running !== undefined && (
        <p className="finish-line" role="status">
          <span className="mark" data-tone="live" aria-hidden="true">
            ●
          </span>
          {view.running}
        </p>
      )}
      {confirming ? (
        <div className="drawer-confirm" role="group" aria-label={TEXT.discardConfirm}>
          <p>{TEXT.discardQuestion}</p>
          <div className="choices">
            <button
              type="button"
              className="choice danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onFinish("discard");
              }}
            >
              {TEXT.discardConfirm}
            </button>
            <button type="button" className="choice" ref={cancel} onClick={() => setConfirming(false)}>
              {TEXT.discardCancel}
            </button>
          </div>
        </div>
      ) : (
        view.buttons.length > 0 && (
          <>
            <div className="choices">
              {view.buttons.map((button) => (
                <button
                  key={button.action}
                  type="button"
                  className={button.action === "discard" ? "choice danger" : button.action === "merge" ? "choice primary" : "choice"}
                  disabled={busy || button.unavailable !== undefined}
                  title={button.unavailable}
                  onClick={() => (button.action === "discard" ? setConfirming(true) : onFinish(button.action))}
                >
                  {button.label}
                </button>
              ))}
            </div>
            {view.buttons.map((button) => button.unavailable !== undefined && <p key={button.action} className="finish-why">{`${button.label}: ${button.unavailable}`}</p>)}
            {view.pushNote !== undefined && <p className="finish-why mono">{view.pushNote}</p>}
          </>
        )
      )}
    </section>
  );
}
