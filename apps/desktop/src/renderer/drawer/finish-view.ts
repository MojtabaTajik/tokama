// What the drawer's Finish section and the list say about a done item's worktree: the three ways
// to finish (Merge, Open PR, Discard), why one is refused or not available, and how the item
// ended. Pure functions, tested without React. Every state has a symbol and a word, so colour is
// never the only signal.
import type { FinishAction, FinishRefusal, GitChange, ItemRecord, Setup } from "@tokama/core";
import { clock } from "../format/time.js";
import { type Mark, markOf } from "../ui/status.js";

/** Text with code parts (paths, branches, commands), shown in the mono font. */
export type Rich = readonly (string | { readonly code: string })[];

export interface FinishButton {
  readonly label: string;
  /** What the button sends; Discard first asks in place; `accept_git_changes` takes the listed changes. */
  readonly action: FinishAction | "accept_git_changes";
  readonly tone: "primary" | "plain" | "danger";
  readonly disabled?: boolean;
}

export interface FinishRow {
  readonly action: FinishAction;
  readonly title: string;
  readonly text: Rich;
  readonly button: FinishButton;
  /** A refusal or failure of this action, said in place. */
  readonly notice?: { readonly headline: string; readonly body: string; readonly changes?: readonly GitChange[] };
  /** Why the action is off now, and how to fix it; `recheck` when checking again can help. */
  readonly off?: { readonly status: Rich; readonly recheck: boolean };
}

export type FinishView =
  | {
      readonly kind: "offer";
      readonly branch: string;
      /** "1 commit ahead of main", or undefined without a commit. */
      readonly ahead?: string;
      /**
       * The one Finish button: Merge, or what a refusal asks for instead (try again, open a PR,
       * take the engineer's git changes); only Discard… for an item with no commit.
       */
      readonly main: FinishButton;
      /** The ways to finish, each with its refusal or why it is off; the button and its menu are drawn from them. */
      readonly rows: readonly FinishRow[];
      /** The running action, e.g. "Merging into main". */
      readonly running?: string;
    }
  | {
      readonly kind: "ended";
      readonly mark: Mark;
      readonly title: string;
      /** The pull request page, as text. */
      readonly url?: string;
      readonly detail: Rich;
      /** The worktree is still there (after a PR, or kept after a merge): Remove worktree asks first. */
      readonly removable: boolean;
      /** The last failure, e.g. a Remove worktree that did not finish. */
      readonly failure?: string;
    };

const ACTION_WORD: Record<FinishAction, string> = { merge: "Merge", pull_request: "Open PR", discard: "Discard" };

/**
 * The actions a done item offers now: core's `finishActions`, restated because the renderer may
 * import only types from core.
 */
export function finishActions(item: Pick<ItemRecord, "outcome" | "finish">): FinishAction[] {
  const { finish, outcome } = item;
  if (outcome?.kind !== "done" || finish === undefined || finish.running !== undefined || finish.worktreeRemoved) return [];
  const committed = (outcome.commits?.length ?? 0) > 0 && finish.merged === undefined && finish.pullRequest === undefined;
  return [...(committed ? (["merge", "pull_request"] as const) : []), "discard"];
}

/** The repo's base branch from the setup; "the base branch" when the setup does not list it. */
export const baseBranchOf = (item: Pick<ItemRecord, "repoIds">, setup: Setup | undefined): string =>
  setup?.repos.find((repo) => repo.id === item.repoIds[0])?.baseBranch ?? "the base branch";

const branchOf = (item: Pick<ItemRecord, "outcome">): string => item.outcome?.commits?.[0]?.branch ?? "the item branch";

/** "PR #12" from its URL. */
export const prName = (url: string): string => `PR #${/\/pull\/(\d+)$/.exec(url)?.[1] ?? "?"}`;

const FAIL = markOf("failed").symbol;
const withTime = (text: string, at: number | undefined): string => (at === undefined ? text : `${text} · ${clock(at)}`);

/** Why Open PR is off: a local-only item, nowhere to push, or gh missing or logged out. */
function prOff(item: Pick<ItemRecord, "finish" | "privacy">, setup: Setup | undefined): { readonly why: string; readonly status: Rich; readonly recheck: boolean } | undefined {
  if (item.privacy === "local_only") return { why: "This item is local only: its template lets nothing leave this machine.", status: [`${FAIL} local only`], recheck: false };
  if (item.finish?.pushTarget === undefined) {
    return { why: "The repo had no GitHub remote named origin when the item started.", status: [`${FAIL} no origin · add one with `, { code: "git remote add origin …" }, " for the next item"], recheck: false };
  }
  const gh = setup?.health.gh;
  if (gh !== undefined && !gh.installed) return { why: "Needs the GitHub CLI (gh). It was not found on your PATH.", status: [`${FAIL} gh not found · install it from cli.github.com`], recheck: true };
  if (gh !== undefined && !gh.loggedIn) return { why: "gh is installed but not logged in.", status: [`${FAIL} logged out · run `, { code: "gh auth login" }, " in a terminal"], recheck: true };
  return undefined;
}

const REFUSAL_HEADLINE: Record<FinishRefusal, (base: string) => string> = {
  dirty_checkout: () => "Your checkout has uncommitted changes.",
  other_branch: () => "Your checkout is on another branch.",
  conflict: (base) => `${base} has moved and the merge has conflicts.`,
  files_in_the_way: () => "Your checkout has files where the merge writes.",
  steering_changed: () => "The repo's git config or hooks changed.",
};

const ACCEPT: FinishButton = { label: "I made this change", action: "accept_git_changes", tone: "plain" };

export function finishView(item: Pick<ItemRecord, "outcome" | "finish" | "repoIds" | "privacy">, setup: Setup | undefined): FinishView | undefined {
  const finish = item.finish;
  if (item.outcome?.kind !== "done" || finish === undefined) return undefined;
  const base = baseBranchOf(item, setup);
  const branch = branchOf(item);
  const failure = finish.failed;

  if (finish.merged !== undefined || finish.pullRequest !== undefined || finish.worktreeRemoved) {
    const removable = !finish.worktreeRemoved && finish.running === undefined;
    const failed = failure === undefined ? {} : { failure: `${ACTION_WORD[failure.action]} did not finish: ${failure.detail}` };
    if (finish.merged !== undefined) {
      return {
        kind: "ended",
        mark: markOf("done", "merged"),
        title: withTime(`Merged into ${finish.merged.baseBranch} · ${finish.merged.commit.slice(0, 7)}`, finish.at),
        detail: [finish.worktreeRemoved ? "Worktree and branch removed" : (finish.detail ?? "The worktree is kept.")],
        removable,
        ...failed,
      };
    }
    if (finish.pullRequest !== undefined) {
      return {
        kind: "ended",
        mark: markOf("pull_request"),
        title: `${prName(finish.pullRequest.url)} open`,
        url: finish.pullRequest.url,
        detail: finish.worktreeRemoved ? [withTime("Worktree and branch removed", finish.at)] : ["Pushed ", { code: branch }, " · the worktree stays until the PR is merged or closed"],
        removable,
        ...failed,
      };
    }
    return { kind: "ended", mark: markOf("discarded"), title: "Discarded", detail: [`${withTime("Worktree and branch deleted", finish.at)} · the log is kept`], removable: false };
  }

  const committed = (item.outcome.commits?.length ?? 0) > 0;
  const running = finish.running;
  const busy = running !== undefined;
  const repo = setup?.repos.find((entry) => entry.id === item.repoIds[0]);
  const notice = (action: FinishAction) => {
    if (failure?.action !== action) return undefined;
    const headline = failure.reason !== undefined ? REFUSAL_HEADLINE[failure.reason](base) : `${ACTION_WORD[action]} did not finish.`;
    return { notice: { headline, body: failure.detail, ...(failure.changes !== undefined && { changes: failure.changes }) } };
  };
  const off = prOff(item, setup);
  const rows: FinishRow[] = [];
  if (committed) {
    const conflict = failure?.action === "merge" && failure.reason === "conflict";
    const steering = failure?.reason === "steering_changed";
    rows.push({
      action: "merge",
      title: `Merge into ${base}`,
      text: ["Merges into your checkout", ...(repo?.path === undefined ? [] : [" at ", { code: repo.path }]), ", then removes the worktree and the branch."],
      button: steering && failure.action === "merge"
        ? { ...ACCEPT, disabled: busy }
        : conflict
        ? { label: "Open PR instead", action: "pull_request", tone: "plain", disabled: busy || off !== undefined }
        : failure?.action === "merge"
          ? { label: "Try again", action: "merge", tone: "plain", disabled: busy }
          : { label: `Merge into ${base}`, action: "merge", tone: "primary", disabled: busy },
      ...notice("merge"),
    });
    rows.push({
      action: "pull_request",
      title: "Open PR",
      text: off !== undefined ? [off.why] : ["Pushes ", { code: branch }, " to ", { code: finish.pushTarget ?? "origin" }, " and opens a pull request with gh. The worktree stays until the PR is merged."],
      button:
        steering && failure.action === "pull_request"
          ? { ...ACCEPT, disabled: busy }
          : { label: failure?.action === "pull_request" && off === undefined ? "Try again" : "Open PR", action: "pull_request", tone: "plain", disabled: busy || off !== undefined },
      ...(off !== undefined && { off: { status: off.status, recheck: off.recheck } }),
      ...notice("pull_request"),
    });
  }
  rows.push({
    action: "discard",
    title: "Discard",
    text: [committed ? "Deletes the worktree and the branch. The commit is lost." : "Deletes the worktree and the branch."],
    button: { label: "Discard…", action: "discard", tone: "danger", disabled: busy },
    ...notice("discard"),
  });
  const runningText = running === undefined ? undefined : { merge: `Merging into ${base}`, pull_request: "Pushing the branch and opening a pull request", discard: "Removing the worktree and the branch" }[running];
  return {
    kind: "offer",
    branch,
    ...(committed && { ahead: `1 commit ahead of ${base}` }),
    // Taking the git changes comes first, whichever way was refused; else the first way (Merge, or Discard… without a commit).
    main: rows.find((row) => row.button.action === "accept_git_changes")?.button ?? rows[0]!.button,
    rows,
    ...(runningText !== undefined && { running: runningText }),
  };
}

/** The drawer's state line after a finish: "merged", "PR open"; undefined before. */
export function finishState(item: Pick<ItemRecord, "finish">): string | undefined {
  const finish = item.finish;
  if (finish?.merged !== undefined) return "merged";
  if (finish?.pullRequest !== undefined) return "PR open";
  return undefined;
}

/** A discarded item: its work is gone, so it reads as discarded rather than done. */
export const isDiscarded = (item: Pick<ItemRecord, "finish">): boolean =>
  item.finish !== undefined && item.finish.worktreeRemoved && item.finish.merged === undefined && item.finish.pullRequest === undefined;

/** How a finished row ends in the list, with its mark; undefined before any finish action ran. */
export function finishNote(item: Pick<ItemRecord, "finish">): { readonly mark: Mark; readonly text: string } | undefined {
  const finish = item.finish;
  if (finish === undefined) return undefined;
  if (finish.running !== undefined) return { mark: markOf("running"), text: `${ACTION_WORD[finish.running]} running` };
  if (finish.merged !== undefined) return { mark: markOf("done", "merged"), text: `Merged into ${finish.merged.baseBranch} · ${finish.merged.commit.slice(0, 7)}` };
  if (finish.pullRequest !== undefined) return { mark: markOf("pull_request"), text: `${prName(finish.pullRequest.url)} open` };
  if (finish.worktreeRemoved) return { mark: markOf("discarded"), text: "Discarded" };
  if (finish.failed !== undefined) return { mark: markOf("warning", "refused"), text: `${ACTION_WORD[finish.failed.action]} did not finish` };
  return undefined;
}

/** What Open PR does for this item, with where the branch goes: "Push tokama/00000011 to github.com/acme/orders-api and open a PR with gh". Undefined without a push target. */
export function prPushNote(item: Pick<ItemRecord, "outcome" | "finish">): string | undefined {
  const target = item.finish?.pushTarget;
  return target === undefined ? undefined : `Push ${branchOf(item)} to ${target} and open a PR with gh`;
}

/** Why Open PR is off for this item, for the list's menu; undefined when it can run. */
export const prUnavailable = (item: Pick<ItemRecord, "finish" | "privacy">, setup: Setup | undefined): string | undefined => prOff(item, setup)?.why;
