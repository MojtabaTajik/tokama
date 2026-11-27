// The drawer's Finish section for a done item. Before a finish: the one Finish button (Merge into
// the base branch, with Open PR and Discard… under its arrow), the item branch, and in place a
// refusal or why Open PR is off; Discard asks in place first. After a finish: how the item ended.
// Each action is a change outside the worktree that the engine runs on this click; its result
// comes back as item updates. Engine and repo text (paths, branches, URLs, git's words) is text only.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { useEffect, useRef, useState } from "react";
import { baseBranchOf, finishView, type FinishRow, prUnavailable, type Rich } from "./finish-view.js";
import { Button } from "../ui/Button.js";
import { FinishSplit } from "../ui/FinishSplit.js";
import { StatusMark } from "../ui/status.js";

const TEXT = {
  more: (title: string) => `More ways to finish ${title}`,
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
  /** The full view draws the Finish button in its header (`FinishButton`): the section leaves it out. */
  readonly buttonElsewhere?: boolean | undefined;
}

/** Text with code parts (branches, commits) in mono; `codeClass` styles the code parts. */
export function Text({ parts, codeClass = "mono" }: { readonly parts: Rich; readonly codeClass?: string }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <code key={index} className={codeClass}>
            {part.code}
          </code>
        ),
      )}
    </>
  );
}

export function Finish({ item, setup, busy, onFinish, onCheckAgain, onAcceptChanges, askDiscard, buttonElsewhere }: FinishProps) {
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
  // Asking again while the question is open moves focus to it too.
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming, askDiscard]);
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

  const pr = view.rows.find((row) => row.action === "pull_request");
  return (
    <section className="finish" aria-label={TEXT.finish}>
      <div className="finish-bar">
        {buttonElsewhere !== true && <FinishButton item={item} setup={setup} busy={busy} onFinish={onFinish} onAcceptChanges={onAcceptChanges} onAskDiscard={() => setConfirming(true)} />}
        <p className="finish-head">
          <span className="finish-label">{TEXT.finish}</span>
          <code className="mono">{view.branch}</code>
          {view.ahead !== undefined && <span> · {view.ahead}</span>}
        </p>
      </div>
      {view.running !== undefined && (
        <p className="finish-running" role="status">
          <StatusMark status="running" />{" "}
          {view.running}
        </p>
      )}
      {pr?.off !== undefined && (
        <p className="finish-off">
          <Text parts={pr.off.status} />
          {pr.off.recheck && onCheckAgain !== undefined && (
            <Button variant="link" onClick={onCheckAgain}>
              {TEXT.checkAgain}
            </Button>
          )}
        </p>
      )}
      {view.rows.map((row) => row.notice !== undefined && <Notice key={row.action} row={row} notice={row.notice} />)}
      {confirm}
    </section>
  );
}

/**
 * The one Finish button of a done item that still has a worktree: Merge (or what a refusal asks
 * for instead) with ▾ for Open PR and Discard…; just Discard… when there is no commit to merge.
 * Nothing for an item that is finished already.
 */
export function FinishButton({ item, setup, busy, onFinish, onAcceptChanges, onAskDiscard }: Pick<FinishProps, "item" | "setup" | "busy" | "onFinish"> & { readonly onAcceptChanges: (() => void) | undefined; readonly onAskDiscard: () => void }) {
  const view = finishView(item, setup);
  if (view?.kind !== "offer") return null;
  const waiting = busy || view.running !== undefined;
  if (view.main.action === "discard") {
    return (
      <Button variant="danger" disabled={waiting} onClick={onAskDiscard}>
        {view.main.label}
      </Button>
    );
  }
  return (
    <FinishSplit
      variant="filled"
      base={baseBranchOf(item, setup)}
      prOff={prUnavailable(item, setup)}
      moreLabel={TEXT.more(item.title)}
      main={view.main}
      disabled={waiting}
      // The menu item or the button that had focus goes with the pick: focus stays in the drawer or the full view.
      onPicked={(from) => from?.closest<HTMLElement>(".drawer, .expanded")?.focus()}
      onPick={(pick) => (pick === "discard" ? onAskDiscard() : pick === "accept_git_changes" ? onAcceptChanges?.() : onFinish(pick))}
    />
  );
}

/** A refusal or failure of a way to finish, said in place with the engine's words. */
function Notice({ row, notice }: { readonly row: FinishRow; readonly notice: NonNullable<FinishRow["notice"]> }) {
  return (
    <div className="finish-notice" role="status">
      <p className="finish-notice-title">
        <span className="mark" data-tone="warn" aria-hidden="true">
          !
        </span>{" "}
        {notice.headline}
      </p>
      <p className="finish-notice-body">{notice.body}</p>
      {notice.changes !== undefined && notice.changes.length > 0 && (
        <ul className="finish-changes" aria-label={TEXT.changes}>
          {notice.changes.map((change, index) => (
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
  );
}
