// The drawer's Finish section for a done item. Before a finish: the item branch and three rows
// (Merge into the base branch, Open PR, Discard), each with what it does, its button, and in place
// its refusal or why it is off; Discard asks in place first. After a finish: how the item ended.
// Each action is a change outside the worktree that the engine runs on this click; its result
// comes back as item updates. Engine and repo text (paths, branches, URLs, git's words) is text only.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { finishView, type FinishRow, type Rich } from "./finish-view.js";
import { Button } from "../ui/Button.js";
import { StatusMark } from "../ui/status.js";

const TEXT = {
  finish: "Finish",
  checkAgain: "Check again",
  removeWorktree: "Remove worktree",
  discardQuestion: "Discard this work?",
  discardWhat: (branch: string, committed: boolean) => [
    "Deletes the worktree and the branch ",
    { code: branch },
    committed ? " with its 1 commit. The item and its log stay. This can't be undone." : ". The item and its log stay. This can't be undone.",
  ],
  discardConfirm: "Discard",
  changes: "What changed",
  before: "was",
  after: "now",
  notYou: "If you did not make these changes, check them first: Tokama would merge or push with them in place. Discard stays available.",
  discardCancel: "Keep",
} as const;

export interface FinishProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly busy: boolean;
  readonly onFinish: (action: FinishAction) => void;
  /** Reads the setup again, e.g. after gh was installed or logged in. */
  readonly onCheckAgain?: () => void;
  /** The engineer made the listed git config or hooks changes. */
  readonly onAcceptChanges?: () => void;
  /** Opens the Discard question (Discard… from the list); each new value asks again. */
  readonly askDiscard?: number | undefined;
}

function Text({ parts }: { readonly parts: Rich }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <code key={index} className="mono">
            {part.code}
          </code>
        ),
      )}
    </>
  );
}

export function Finish({ item, setup, busy, onFinish, onCheckAgain, onAcceptChanges, askDiscard }: FinishProps) {
  const [confirming, setConfirming] = useState(askDiscard !== undefined);
  const keep = useRef<HTMLButtonElement>(null);
  const view = finishView(item, setup);
  const running = view?.kind === "offer" ? view.running : undefined;

  useEffect(() => {
    if (askDiscard !== undefined) setConfirming(true);
  }, [askDiscard]);
  // An action that starts closes the question: what it would discard is changing.
  useEffect(() => {
    if (running !== undefined) setConfirming(false);
  }, [running]);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  // Escape closes the question first; the drawer closes only on the next Escape.
  useEffect(() => {
    if (!confirming) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setConfirming(false);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [confirming]);

  if (view === undefined) return null;
  const branch = view.kind === "offer" ? view.branch : (item.outcome?.commits?.[0]?.branch ?? "the item branch");
  // Only while there is something to discard and nothing runs.
  const confirm = confirming && running === undefined && (view.kind === "offer" || view.removable) && (
    <div className="finish-confirm" role="group" aria-label={TEXT.discardQuestion}>
      <p className="finish-confirm-title">{TEXT.discardQuestion}</p>
      <p className="finish-text">
        <Text parts={TEXT.discardWhat(branch, (item.outcome?.commits?.length ?? 0) > 0)} />
      </p>
      <div className="choices">
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            onFinish("discard");
          }}
        >
          {TEXT.discardConfirm}
        </Button>
        <Button variant="secondary" ref={keep} onClick={() => setConfirming(false)}>
          {TEXT.discardCancel}
        </Button>
      </div>
    </div>
  );

  if (view.kind === "ended") {
    return (
      <section className="finish-ended" aria-label={TEXT.finish}>
        <span className="mark" data-tone={view.mark.tone} aria-hidden="true">
          {view.mark.symbol}
        </span>
        <div className="finish-ended-body">
          <p className="finish-ended-title">
            <span className="visually-hidden">{view.mark.word}: </span>
            {view.title}
          </p>
          {view.url !== undefined && <p className="finish-url mono">{view.url}</p>}
          <p className="finish-text">
            <Text parts={view.detail} />
          </p>
          {view.failure !== undefined && (
            <p className="finish-notice-body" role="status">
              <StatusMark status="failed" />{" "}
              {view.failure}
            </p>
          )}
          {view.removable && !confirming && (
            <Button variant="link" disabled={busy} onClick={() => setConfirming(true)}>
              {TEXT.removeWorktree}
            </Button>
          )}
          {confirm}
        </div>
      </section>
    );
  }

  return (
    <section className="finish" aria-label={TEXT.finish}>
      <p className="finish-head">
        <span className="finish-label">{TEXT.finish}</span>
        <code className="mono">{view.branch}</code>
        {view.ahead !== undefined && <span> · {view.ahead}</span>}
      </p>
      {view.running !== undefined && (
        <p className="finish-running" role="status">
          <StatusMark status="running" />{" "}
          {view.running}
        </p>
      )}
      {view.rows.map((row) => (
        <Row key={row.action} row={row} busy={busy} onFinish={onFinish} onDiscard={() => setConfirming(true)} onCheckAgain={onCheckAgain} onAcceptChanges={onAcceptChanges}>
          {row.action === "discard" && confirm}
        </Row>
      ))}
    </section>
  );
}

interface RowProps {
  readonly row: FinishRow;
  readonly busy: boolean;
  readonly onFinish: (action: FinishAction) => void;
  readonly onDiscard: () => void;
  readonly onCheckAgain: (() => void) | undefined;
  readonly onAcceptChanges: (() => void) | undefined;
  readonly children?: ReactNode;
}

function Row({ row, busy, onFinish, onDiscard, onCheckAgain, onAcceptChanges, children }: RowProps) {
  const { button } = row;
  const variant = button.tone === "primary" ? "primary" : button.tone === "danger" ? "danger" : "secondary";
  return (
    <div className="finish-row" data-action={row.action}>
      <div className="finish-row-main">
        <div className="finish-row-body">
          <p className="finish-title">{row.title}</p>
          <p className="finish-text">
            <Text parts={row.text} />
          </p>
          {row.off !== undefined && (
            <p className="finish-off">
              <Text parts={row.off.status} />
              {row.off.recheck && onCheckAgain !== undefined && (
                <Button variant="link" onClick={onCheckAgain}>
                  {TEXT.checkAgain}
                </Button>
              )}
            </p>
          )}
          {row.notice !== undefined && (
            <div className="finish-notice" role="status">
              <p className="finish-notice-title">
                <span className="mark" data-tone="warn" aria-hidden="true">
                  !
                </span>{" "}
                {row.notice.headline}
              </p>
              <p className="finish-notice-body">{row.notice.body}</p>
              {row.notice.changes !== undefined && row.notice.changes.length > 0 && (
                <ul className="finish-changes" aria-label={TEXT.changes}>
                  {row.notice.changes.map((change, index) => (
                    <li key={index}>
                      <span className="finish-change-what mono">{change.what}</span>
                      {change.before !== undefined && (
                        <span className="finish-change-value">
                          {TEXT.before} <code className="mono">{change.before}</code>
                        </span>
                      )}
                      {change.after !== undefined && (
                        <span className="finish-change-value">
                          {TEXT.after} <code className="mono">{change.after}</code>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {row.button.action === "accept_git_changes" && <p className="finish-notice-body">{TEXT.notYou}</p>}
            </div>
          )}
        </div>
        <Button
          variant={variant}
          disabled={busy || button.disabled === true}
          onClick={() => {
            if (button.action === "accept_git_changes") onAcceptChanges?.();
            else if (button.action === "discard") onDiscard();
            else onFinish(button.action);
          }}
        >
          {button.label}
        </Button>
      </div>
      {children}
    </div>
  );
}
