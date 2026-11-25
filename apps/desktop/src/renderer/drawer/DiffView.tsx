// The change a decision asks you to approve. In the drawer's Diff tab: a summary line, the changed
// files, and the clicked file as a unified diff with line numbers. On a Needs you row: the changed
// files with their counts. The diff is repo content: it is rendered as React text only, never as
// HTML. Added and removed lines carry + and − as well as colour. Characters that reorder or hide
// text (bidi controls, line separators) are shown as visible escapes, and a path with a control
// character is shown quoted, so a line cannot read differently from what it does. Binary files,
// files over the engine's line limit and anything else left out say so and name the worktree.
import type { Decision, DiffFile, ItemDiff } from "@tokama/core";
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";

/** The engine shows the hunks of files with up to this many changed lines. */
export const FILE_LINES = 1000;

const TEXT = {
  loading: "Loading the change",
  failed: (message: string) => `Could not load the change: ${message}`,
  none: "The step changed no files.",
  files: (count: number) => `${count} file${count === 1 ? "" : "s"}`,
  from: (branch: string) => `from ${branch}`,
  changedFiles: "Changed files",
  more: (count: number) => `${count} more file${count === 1 ? "" : "s"} not listed`,
  where: (repoId: string, path: string) => `In repo ${repoId}: ${path}`,
  binary: "binary",
  tooLarge: "too large",
  binaryHead: "Binary file, not shown here.",
  binaryText: "Open it in your editor or an image viewer to compare.",
  tooLargeHead: "Too large to show here.",
  tooLargeText: (lines: number) => `${lines.toLocaleString("en")} changed lines; the drawer shows files up to ${FILE_LINES.toLocaleString("en")} changed lines. Open it in your editor to review.`,
  cutHead: "Not shown here in full.",
  cutText: "The change is too big to send to the app in one piece. Open the file in your editor to review all of it.",
  restCut: "The rest of this file is not shown here. Open it in your editor to review all of it.",
  changed: "Changed",
  nothingCommitted: "nothing committed yet",
  moreChanged: (count: number) => `${count} more`,
} as const;

const STATUS: Readonly<Record<DiffFile["status"], { readonly letter: string; readonly word: string }>> = {
  added: { letter: "A", word: "added" },
  modified: { letter: "M", word: "modified" },
  deleted: { letter: "D", word: "deleted" },
  renamed: { letter: "R", word: "renamed" },
  type_changed: { letter: "T", word: "type changed" },
};

// Every bidi control (embeddings, overrides, isolates, marks), and the line and paragraph separators.
const REORDERING = /\p{Bidi_Control}|[\u2028\u2029]/gu;

/** Text with every character that can reorder or hide what follows shown as `<U+202E>`. */
export function visible(text: string): string {
  return text.replace(REORDERING, (char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`);
}

/** A path on one line: quoted and escaped when it holds a control character, so it never looks like two lines. */
export function shownPath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return visible(/[\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : path);
}

/** Why a file's lines are not drawn: binary, over the line limit, or left out of the reply. */
export type Hidden = "binary" | "too large" | "cut" | undefined;

export function hiddenOf(file: DiffFile): Hidden {
  if (file.binary) return "binary";
  if (!file.cut || file.hunks.length > 0) return undefined;
  return (file.added ?? 0) + (file.removed ?? 0) > FILE_LINES ? "too large" : "cut";
}

export interface DiffRow {
  readonly kind: "hunk" | "added" | "removed" | "unchanged" | "note";
  /** Line numbers before and after; empty where the line does not exist. */
  readonly a: string;
  readonly b: string;
  readonly text: string;
}

/** A file's hunks as rows with line numbers, read from each `@@ -a,b +c,d @@` header. */
export function diffRows(file: DiffFile): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of file.hunks) {
    const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk.header);
    let a = Number(start?.[1] ?? 0);
    let b = Number(start?.[2] ?? 0);
    rows.push({ kind: "hunk", a: "", b: "", text: visible(hunk.header) });
    for (const line of hunk.lines) {
      const text = visible(line.slice(1));
      if (line.startsWith("+")) rows.push({ kind: "added", a: "", b: String(b++), text });
      else if (line.startsWith("-")) rows.push({ kind: "removed", a: String(a++), b: "", text });
      else if (line.startsWith("\\")) rows.push({ kind: "note", a: "", b: "", text: visible(line) });
      else rows.push({ kind: "unchanged", a: String(a++), b: String(b++), text });
    }
  }
  return rows;
}

/** Added and removed lines over all listed text files. */
export function totals(diff: Pick<ItemDiff, "files">): { readonly added: number; readonly removed: number } {
  return diff.files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }), { added: 0, removed: 0 });
}

const count = (value: number) => value.toLocaleString("en");

export type DiffState = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly diff: ItemDiff };

const LOADING: DiffState = { kind: "loading" };

/**
 * The change of an open decision, asked for again when the decision changes. An answer is kept
 * with the decision it is for, so a newer question never shows an older change, not even for one frame.
 */
export function useDecisionDiff(bridge: TokamaBridge, itemId: string, decision: Decision | undefined): DiffState | undefined {
  const [answer, setAnswer] = useState<{ readonly for: string; readonly state: DiffState } | undefined>(undefined);
  const decisionId = decision?.hasDiff === true ? decision.id : undefined;
  useEffect(() => {
    if (decisionId === undefined) return;
    let current = true;
    void bridge
      .query({ type: "decision_diff", itemId, decisionId })
      .then((reply) => {
        if (current) setAnswer({ for: decisionId, state: reply.ok ? { kind: "loaded", diff: reply.data } : { kind: "failed", message: reply.error.message } });
      })
      .catch((cause: unknown) => {
        if (current) setAnswer({ for: decisionId, state: { kind: "failed", message: String(cause) } });
      });
    return () => {
      current = false;
    };
  }, [bridge, itemId, decisionId]);
  if (decisionId === undefined) return undefined;
  return answer?.for === decisionId ? answer.state : LOADING;
}

function Status({ state }: { readonly state: Exclude<DiffState, { kind: "loaded" }> }) {
  if (state.kind === "loading") return <p className="placeholder">{TEXT.loading}</p>;
  return (
    <p className="drawer-error" role="alert">
      <span className="symbol" aria-hidden="true">
        ✕
      </span>
      {TEXT.failed(state.message)}
    </p>
  );
}

function Counts({ file }: { readonly file: DiffFile }) {
  const hidden = hiddenOf(file);
  return (
    <span className="dv-counts mono">
      {hidden !== "binary" && hidden !== "too large" && (
        <>
          <span className="dv-added">+{count(file.added ?? 0)}</span>
          <span className="dv-removed">−{count(file.removed ?? 0)}</span>
        </>
      )}
      {(hidden === "binary" || hidden === "too large") && <span className="dv-flag">{hidden === "binary" ? TEXT.binary : TEXT.tooLarge}</span>}
    </span>
  );
}

/** The drawer's Diff tab for an open decision that shows a change. */
export function DiffTab({ state, baseBranch }: { readonly state: DiffState; readonly baseBranch: string | undefined }) {
  const [picked, setPicked] = useState(0);
  if (state.kind !== "loaded") return <Status state={state} />;
  const { diff } = state;
  if (diff.files.length === 0 && diff.moreFiles === 0) return <p className="placeholder">{TEXT.none}</p>;
  const sum = totals(diff);
  const file = diff.files[Math.min(picked, diff.files.length - 1)];
  return (
    <div className="dv">
      <p className="dv-summary">
        <span>
          <span className="mono dv-strong">{diff.files.length + diff.moreFiles}</span> {diff.files.length + diff.moreFiles === 1 ? "file" : "files"}
        </span>
        <span className="mono">
          <span className="dv-added">+{count(sum.added)}</span> <span className="dv-removed">−{count(sum.removed)}</span>
        </span>
        <span className="dv-muted" aria-hidden="true">
          ·
        </span>
        <span className="mono dv-branch">{diff.worktree.branch}</span>
        <span className="dv-muted">
          {TEXT.from(baseBranch ?? "the base")} <span className="mono">{diff.worktree.baseCommit.slice(0, 7)}</span>
        </span>
      </p>
      <ul className="dv-files" aria-label={TEXT.changedFiles}>
        {diff.files.map((candidate, index) => {
          const status = STATUS[candidate.status];
          return (
            <li key={`${candidate.oldPath ?? ""}\n${candidate.path}`}>
              <button type="button" className="dv-file" aria-pressed={candidate === file} onClick={() => setPicked(index)}>
                <span className="dv-status mono" title={status.word}>
                  <span aria-hidden="true">{status.letter}</span>
                  <span className="visually-hidden">{status.word}</span>
                </span>
                <span className="dv-path mono" title={shownPath(candidate.path)}>
                  <bdi>{candidate.oldPath === undefined ? shownPath(candidate.path) : `${shownPath(candidate.oldPath)} → ${shownPath(candidate.path)}`}</bdi>
                </span>
                <Counts file={candidate} />
              </button>
            </li>
          );
        })}
        {diff.moreFiles > 0 && <li className="dv-more">{TEXT.more(diff.moreFiles)}</li>}
      </ul>
      {file !== undefined && <FilePanel file={file} worktree={diff.worktree} />}
    </div>
  );
}

function FilePanel({ file, worktree }: { readonly file: DiffFile; readonly worktree: ItemDiff["worktree"] }) {
  const hidden = hiddenOf(file);
  const status = STATUS[file.status];
  const rows = hidden === undefined ? diffRows(file) : [];
  const summary = file.binary ? TEXT.binary : `${status.word} · +${count(file.added ?? 0)} −${count(file.removed ?? 0)}`;
  return (
    <section className="dv-panel" aria-label={shownPath(file.path)}>
      <p className="dv-panel-head">
        <span className="mono dv-panel-path">{shownPath(file.path)}</span>
        <span className="mono dv-muted">{summary}</span>
      </p>
      {hidden === undefined ? (
        <>
          <div className="dv-lines mono" role="table" aria-label={`Unified diff of ${shownPath(file.path)}`} tabIndex={0}>
            {rows.map((row, index) => (
              <div key={index} role="row" className="dv-row" data-kind={row.kind}>
                <span role="cell" className="dv-num">
                  {row.a}
                </span>
                <span role="cell" className="dv-num">
                  {row.b}
                </span>
                <span role="cell" className="dv-sign" aria-label={row.kind === "hunk" || row.kind === "note" ? undefined : row.kind}>
                  {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
                </span>
                <span role="cell" className="dv-text">
                  {row.text}
                </span>
              </div>
            ))}
          </div>
          {file.cut && <p className="dv-note-text dv-rest">{TEXT.restCut}</p>}
        </>
      ) : (
        <div className="dv-note">
          <span className="dv-note-head">{hidden === "binary" ? TEXT.binaryHead : hidden === "too large" ? TEXT.tooLargeHead : TEXT.cutHead}</span>
          <span className="dv-note-text">{hidden === "binary" ? TEXT.binaryText : hidden === "too large" ? TEXT.tooLargeText((file.added ?? 0) + (file.removed ?? 0)) : TEXT.cutText}</span>
          <span className="dv-note-text mono">{TEXT.where(worktree.repoId, `${worktree.dir}/${shownPath(file.path)}`)}</span>
        </div>
      )}
    </section>
  );
}

/** How many text files the Needs you row lists before it counts the rest. */
const ROW_FILES = 5;

/** The changed files on a Needs you row: text files with their counts, then the ones not drawn on one line. */
export function ChangedFiles({ state, context }: { readonly state: DiffState; readonly context: string }) {
  if (state.kind !== "loaded") return <Status state={state} />;
  const { diff } = state;
  const shown = diff.files.filter((file) => hiddenOf(file) !== "binary" && hiddenOf(file) !== "too large");
  const hidden = diff.files.filter((file) => hiddenOf(file) === "binary" || hiddenOf(file) === "too large");
  const rest = Math.max(0, shown.length - ROW_FILES) + diff.moreFiles;
  const total = diff.files.length + diff.moreFiles;
  return (
    <div className="dv-changed">
      <p className="dv-changed-head">
        <span className="dv-label">{TEXT.changed}</span>
        <span className="dv-muted">
          {TEXT.files(total)} · {TEXT.nothingCommitted}
        </span>
      </p>
      {total > 0 && (
        <ul className="dv-changed-list mono" aria-label={`${TEXT.changedFiles}: ${context}`}>
          {shown.slice(0, ROW_FILES).map((file) => (
            <li key={`${file.oldPath ?? ""}\n${file.path}`}>
              <span className="dv-path">
                <bdi>{shownPath(file.path)}</bdi>
              </span>
              <Counts file={file} />
            </li>
          ))}
          {hidden.length > 0 && (
            <li className="dv-muted-line">
              <span className="dv-path">
                <bdi>{hidden.map((file) => shownPath(file.path)).join(" · ")}</bdi>
              </span>
              <span className="dv-flag">{[...new Set(hidden.map((file) => hiddenOf(file)))].join(" · ")}</span>
            </li>
          )}
          {rest > 0 && <li className="dv-muted-line">{TEXT.moreChanged(rest)}</li>}
        </ul>
      )}
    </div>
  );
}
