// The change a decision asks you to approve, or what an ended item changed (with its own header
// lines in place of the summary line). In the drawer's Diff tab: a summary line, the changed
// files, and the clicked file as a unified diff with line numbers. In the full view the file list
// sits left of the file, which shows side by side (before | after) when there is room. On a Needs you row: the changed
// files with their counts. The diff is repo content: it is rendered as React text only, never as
// HTML. Added and removed lines carry + and − as well as colour. Characters that reorder or hide
// text (bidi controls, line separators) are shown as visible escapes, and a path with a control
// character is shown quoted, so a line cannot read differently from what it does. Binary files,
// files over the engine's line limit and anything else left out say so and name the worktree.
import type { DiffFile, ItemDiff, TreeDiff } from "@tokama/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./Button.js";
import { Placeholder } from "./EmptyState.js";
import { ExpandButton } from "./ExpandButton.js";
import { StatusMark } from "./status.js";

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
  by: "by",
  expand: "Open diff in full view",
  expandTip: "Open in full view",
  sideBySide: "Side by side",
  unified: "Unified",
  diffView: "Diff view",
  tooNarrow: "Unified · too narrow for side by side",
  before: (branch: string) => `Before · ${branch}`,
  after: "After · worktree",
  noLine: "no line",
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

/** One side of a side-by-side row: a line as it was (left) or is now (right). */
export interface SideCell {
  readonly kind: "added" | "removed" | "unchanged";
  readonly n: string;
  readonly text: string;
}

/** A side-by-side row: a hunk header or a note across both sides, or a line pair where either side may be missing. */
export type SplitRow = { readonly kind: "hunk" | "note"; readonly text: string } | { readonly kind: "pair"; readonly left: SideCell | undefined; readonly right: SideCell | undefined };

/** Unified rows as side-by-side rows: an unchanged line on both sides, each run of removed lines next to the added lines that follow it. */
export function pairRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let at = 0;
  while (at < rows.length) {
    const row = rows[at]!;
    if (row.kind === "hunk" || row.kind === "note") {
      out.push({ kind: row.kind, text: row.text });
      at++;
    } else if (row.kind === "unchanged") {
      out.push({ kind: "pair", left: { kind: "unchanged", n: row.a, text: row.text }, right: { kind: "unchanged", n: row.b, text: row.text } });
      at++;
    } else {
      const removed: SideCell[] = [];
      const added: SideCell[] = [];
      while (rows[at]?.kind === "removed") removed.push({ kind: "removed", n: rows[at]!.a, text: rows[at++]!.text });
      while (rows[at]?.kind === "added") added.push({ kind: "added", n: rows[at]!.b, text: rows[at++]!.text });
      for (let line = 0; line < Math.max(removed.length, added.length); line++) out.push({ kind: "pair", left: removed[line], right: added[line] });
    }
  }
  return out;
}

/**
 * The narrowest main area that shows a diff side by side: the file list (272 px and its gap) beside
 * two sides of about 330 px each, and the page's padding. Narrower, the diff is unified under the list.
 */
export const SIDE_BY_SIDE_MIN_WIDTH = 1000;

/** Added and removed lines over all listed text files. */
export function totals(diff: Pick<ItemDiff, "files">): { readonly added: number; readonly removed: number } {
  return diff.files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }), { added: 0, removed: 0 });
}

/** A count as the diff shows it: "1,244". */
export const count = (value: number) => value.toLocaleString("en");

/** A diff to draw: an open decision's (with its worktree), or an ended item's. */
export type ShownDiff = TreeDiff & { readonly worktree?: ItemDiff["worktree"] };

export type DiffState = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly diff: ShownDiff };

/** Where the files are, for one that is not drawn: a repo, and the worktree's folder in it while there is one. */
export interface DiffWhere {
  readonly repoId: string;
  readonly dir?: string;
}

function Status({ state }: { readonly state: Exclude<DiffState, { kind: "loaded" }> }) {
  if (state.kind === "loading") return <Placeholder>{TEXT.loading}</Placeholder>;
  return (
    <p className="inline-error" role="alert">
      <StatusMark status="failed" className="symbol" />
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

/** Where the Diff tab is drawn: the drawer, or the full view without or with room for two sides. */
export type DiffLayout = "drawer" | "narrow" | "wide";

export interface DiffTabProps {
  readonly state: DiffState;
  readonly baseBranch: string | undefined;
  /** Default: the drawer. */
  readonly layout?: DiffLayout;
  /** ⤢ in the file's header: opens the diff in the full view. */
  readonly onExpand?: (() => void) | undefined;
  /** Who made the change, at the end of the summary line. */
  readonly by?: ReactNode;
  /** Lines in place of the summary line: an ended item's state and what its diff is compared with. */
  readonly header?: ReactNode;
  /** The side-by-side column heads; default the base branch and the worktree. */
  readonly columns?: { readonly before: string; readonly after: string };
  /** Where the files are; default the diff's worktree. */
  readonly where?: DiffWhere;
}

/** The Diff tab for an open decision that shows a change, or for an ended item, in the drawer or the full view. */
export function DiffTab({ state, baseBranch, layout = "drawer", onExpand, by, header, columns, where }: DiffTabProps) {
  const [picked, setPicked] = useState(0);
  const [split, setSplit] = useState(true);
  // The drawer's file list scrolls on its own: the file you pick stays in view in it.
  const list = useRef<HTMLUListElement>(null);
  const firstPick = useRef(true);
  useEffect(() => {
    if (firstPick.current) firstPick.current = false;
    else list.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [picked]);
  if (state.kind !== "loaded") return <Status state={state} />;
  const { diff } = state;
  if (diff.files.length === 0 && diff.moreFiles === 0) return <Placeholder>{TEXT.none}</Placeholder>;
  const sum = totals(diff);
  const file = diff.files[Math.min(picked, diff.files.length - 1)];
  const at = where ?? (diff.worktree === undefined ? undefined : { repoId: diff.worktree.repoId, dir: diff.worktree.dir });
  const heads = columns ?? { before: TEXT.before(baseBranch ?? "base"), after: TEXT.after };
  return (
    <div className="dv" data-layout={layout}>
      {header ?? (
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
          {diff.worktree !== undefined && (
            <>
              <span className="mono dv-branch">{diff.worktree.branch}</span>
              <span className="dv-muted">
                {TEXT.from(baseBranch ?? "the base")} <span className="mono">{diff.worktree.baseCommit.slice(0, 7)}</span>
              </span>
            </>
          )}
          {by !== undefined && (
            <span className="dv-by">
              {TEXT.by} {by}
            </span>
          )}
        </p>
      )}
      <ul className="dv-files" aria-label={TEXT.changedFiles} ref={list}>
        {diff.files.map((candidate, index) => {
          const status = STATUS[candidate.status];
          return (
            <li key={`${candidate.oldPath ?? ""}\n${candidate.path}`}>
              <Button variant="plain" className="dv-file" aria-pressed={candidate === file} onClick={() => setPicked(index)}>
                <span className="dv-status mono" title={status.word}>
                  <span aria-hidden="true">{status.letter}</span>
                  <span className="visually-hidden">{status.word}</span>
                </span>
                <span className="dv-path mono" title={shownPath(candidate.path)}>
                  <bdi>{candidate.oldPath === undefined ? shownPath(candidate.path) : `${shownPath(candidate.oldPath)} → ${shownPath(candidate.path)}`}</bdi>
                </span>
                <Counts file={candidate} />
              </Button>
            </li>
          );
        })}
        {diff.moreFiles > 0 && <li className="dv-more">{TEXT.more(diff.moreFiles)}</li>}
      </ul>
      {file !== undefined && <FilePanel file={file} where={at} columns={heads} layout={layout} split={split} onSplit={setSplit} onExpand={onExpand} />}
    </div>
  );
}

interface FilePanelProps {
  readonly file: DiffFile;
  readonly where: DiffWhere | undefined;
  readonly columns: { readonly before: string; readonly after: string };
  readonly layout: DiffLayout;
  /** Side by side chosen; it shows only where the layout is wide. */
  readonly split: boolean;
  readonly onSplit: (split: boolean) => void;
  readonly onExpand: (() => void) | undefined;
}

function FilePanel({ file, where, columns, layout, split, onSplit, onExpand }: FilePanelProps) {
  const hidden = hiddenOf(file);
  const sideBySide = layout === "wide" && split;
  const status = STATUS[file.status];
  const rows = hidden === undefined ? diffRows(file) : [];
  const summary = file.binary ? TEXT.binary : `${status.word} · +${count(file.added ?? 0)} −${count(file.removed ?? 0)}`;
  return (
    <section className="dv-panel" aria-label={shownPath(file.path)}>
      <p className="dv-panel-head">
        <span className="mono dv-panel-path">{shownPath(file.path)}</span>
        <span className="mono dv-muted">{summary}</span>
        {hidden === undefined && layout === "wide" && (
          <span className="segments dv-switch" role="group" aria-label={TEXT.diffView}>
            <Button variant="plain" className="segment" aria-pressed={split} onClick={() => onSplit(true)}>
              {TEXT.sideBySide}
            </Button>
            <Button variant="plain" className="segment" aria-pressed={!split} onClick={() => onSplit(false)}>
              {TEXT.unified}
            </Button>
          </span>
        )}
        {hidden === undefined && layout === "narrow" && <span className="dv-switch dv-muted">{TEXT.tooNarrow}</span>}
        {onExpand !== undefined && (
          <ExpandButton className="expand-button" label={TEXT.expand} tip={TEXT.expandTip} onClick={onExpand} />
        )}
      </p>
      {hidden === undefined && sideBySide ? (
        <>
          <SideBySide rows={pairRows(rows)} path={shownPath(file.path)} columns={columns} />
          {file.cut && <p className="dv-note-text dv-rest">{TEXT.restCut}</p>}
        </>
      ) : hidden === undefined ? (
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
          {where !== undefined && <span className="dv-note-text mono">{TEXT.where(where.repoId, where.dir === undefined ? shownPath(file.path) : `${where.dir}/${shownPath(file.path)}`)}</span>}
        </div>
      )}
    </section>
  );
}

/** Old on the left, new on the right; each line has its number and a + or − mark, and a missing line is an empty cell named "no line". */
function SideBySide({ rows, path, columns }: { readonly rows: readonly SplitRow[]; readonly path: string; readonly columns: { readonly before: string; readonly after: string } }) {
  return (
    <div className="dv-lines dv-split mono" role="table" aria-label={`Side-by-side diff of ${path}`} tabIndex={0}>
      <div role="row" className="dv-split-head">
        <span role="columnheader">{columns.before}</span>
        <span role="columnheader">{columns.after}</span>
      </div>
      {rows.map((row, index) =>
        row.kind === "pair" ? (
          <div key={index} role="row" className="dv-srow">
            <Side cell={row.left} />
            <Side cell={row.right} after />
          </div>
        ) : (
          <div key={index} role="row" className="dv-srow" data-kind={row.kind}>
            <span role="cell" className="dv-text">
              {row.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

function Side({ cell, after = false }: { readonly cell: SideCell | undefined; readonly after?: boolean }) {
  const kind = cell?.kind ?? "none";
  return (
    <>
      <span role="cell" className={after ? "dv-num dv-after" : "dv-num"} data-kind={kind}>
        {cell?.n}
      </span>
      <span role="cell" className="dv-sign" data-kind={kind} aria-label={cell === undefined ? TEXT.noLine : cell.kind}>
        {cell?.kind === "added" ? "+" : cell?.kind === "removed" ? "−" : ""}
      </span>
      <span role="cell" className="dv-text" data-kind={kind}>
        {cell?.text}
      </span>
    </>
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
