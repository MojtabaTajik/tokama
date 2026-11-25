// The change a decision asks you to approve, the same in the drawer and on the Needs you page: the
// changed files with their added and removed line counts, then the hunks. The diff is repo
// content: it is rendered as React text only, in a <pre>, and never as HTML. A diff too big for
// one reply says so and names the worktree, where all of it can be read in an editor.
import type { Decision, DiffFile, ItemDiff } from "@tokama/core";
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";

const TEXT = {
  label: "Change to approve",
  loading: "Loading the change",
  failed: (message: string) => `Could not load the change: ${message}`,
  none: "The step changed no files.",
  binary: "binary",
  more: (count: number) => `${count} more file${count === 1 ? "" : "s"} not listed`,
  cut: (where: string, branch: string) => `The diff is too big to show in full. Open the worktree in your editor to see all of it: ${where} (branch ${branch}).`,
} as const;

const STATUS: Readonly<Record<DiffFile["status"], string>> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  type_changed: "type changed",
};

/**
 * A path as text on one line: a path with a line break or another control character is shown
 * quoted and escaped, so it can never look like another file's header.
 */
export function shownPath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : path;
}

/** One file on one line: "modified src/a.ts +2 −1", "renamed old.ts → new.ts +1 −0", "modified logo.png binary". */
export function fileLine(file: DiffFile): string {
  const name = file.oldPath === undefined ? shownPath(file.path) : `${shownPath(file.oldPath)} → ${shownPath(file.path)}`;
  const counts = file.binary ? TEXT.binary : `+${file.added ?? 0} −${file.removed ?? 0}`;
  return `${STATUS[file.status]} ${name} ${counts}${file.cut ? " (cut)" : ""}`;
}

/** The hunks of every file as plain text, each file under its own line. */
export function diffText(diff: Pick<ItemDiff, "files">): string {
  return diff.files
    .filter((file) => file.hunks.length > 0)
    .map((file) => [`── ${shownPath(file.path)}`, ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines])].join("\n"))
    .join("\n\n");
}

type State = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly diff: ItemDiff };

export interface DecisionDiffProps {
  readonly bridge: TokamaBridge;
  readonly itemId: string;
  readonly decision: Decision;
  /** Names the item in the diff's accessible name, where several items share a page. */
  readonly context?: string;
}

export function DecisionDiff({ bridge, itemId, decision, context }: DecisionDiffProps) {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void bridge
      .query({ type: "decision_diff", itemId, decisionId: decision.id })
      .then((reply) => {
        if (current) setState(reply.ok ? { kind: "loaded", diff: reply.data } : { kind: "failed", message: reply.error.message });
      })
      .catch((cause: unknown) => {
        if (current) setState({ kind: "failed", message: String(cause) });
      });
    return () => {
      current = false;
    };
  }, [bridge, itemId, decision.id]);

  const label = context === undefined ? TEXT.label : `${TEXT.label}: ${context}`;
  return (
    <section className="decision-diff cloud-summary" aria-label={label}>
      <p className="cloud-summary-label">
        <span>{TEXT.label}</span>
      </p>
      {state.kind === "loading" && <p className="muted">{TEXT.loading}</p>}
      {state.kind === "failed" && (
        <p className="drawer-error">
          <span className="symbol" aria-hidden="true">
            ✕
          </span>
          {TEXT.failed(state.message)}
        </p>
      )}
      {state.kind === "loaded" && <Loaded diff={state.diff} label={label} />}
    </section>
  );
}

function Loaded({ diff, label }: { readonly diff: ItemDiff; readonly label: string }) {
  if (diff.files.length === 0 && diff.moreFiles === 0) return <p className="muted">{TEXT.none}</p>;
  const text = diffText(diff);
  return (
    <>
      <ul className="decision-diff-files mono">
        {diff.files.map((file) => (
          <li key={`${file.oldPath ?? ""}\n${file.path}`}>{fileLine(file)}</li>
        ))}
        {diff.moreFiles > 0 && <li>{TEXT.more(diff.moreFiles)}</li>}
      </ul>
      {text !== "" && (
        // Focusable, so a long diff can be scrolled with the keyboard.
        <pre className="cloud-summary-text decision-diff-text mono" tabIndex={0} aria-label={label}>
          {text}
        </pre>
      )}
      {diff.cut && (
        <p className="needs-you-why">
          <span className="symbol" aria-hidden="true">
            !{" "}
          </span>
          {TEXT.cut(`${diff.worktree.repoId}/${diff.worktree.dir}`, diff.worktree.branch)}
        </p>
      )}
    </>
  );
}
