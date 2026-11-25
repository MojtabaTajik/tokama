// What the drawer's Finish section and the list say about a done item's worktree: the finish
// actions on offer, why one is not available, and what was done. Pure functions, tested without
// React. Every line has a symbol and a word, so colour is never the only signal.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import type { Mark } from "./describe.js";

export interface FinishButton {
  readonly action: FinishAction;
  readonly label: string;
  /** Why the button can't be used now; undefined when it can. */
  readonly unavailable?: string;
}

export interface FinishView {
  /** What was done, and the last failure. */
  readonly lines: readonly { readonly mark: Mark; readonly text: string }[];
  /** The running action, e.g. "Merging into main". */
  readonly running?: string;
  readonly buttons: readonly FinishButton[];
  /** Where Open PR pushes, e.g. "pushes to github.com/acme/orders-api". */
  readonly pushNote?: string;
}

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

/** The repo's base branch from the setup; "the base branch" when the setup does not list the repo. */
export const baseBranchOf = (item: Pick<ItemRecord, "repoIds">, setup: Setup | undefined): string =>
  setup?.repos.find((repo) => repo.id === item.repoIds[0])?.baseBranch ?? "the base branch";

/** Why Open PR can't be used: a local-only item, no push target, or gh missing or logged out. */
function prUnavailable(item: Pick<ItemRecord, "finish" | "privacy">, setup: Setup | undefined): string | undefined {
  if (item.privacy === "local_only") return "This item is local only: its template lets nothing leave this machine.";
  if (item.finish?.pushTarget === undefined) return "The repo had no origin remote on a code host when the item started.";
  const gh = setup?.health.gh;
  if (gh !== undefined && !(gh.installed && gh.loggedIn)) return gh.message ?? "The GitHub CLI (gh) is not ready.";
  return undefined;
}

export function finishView(item: Pick<ItemRecord, "outcome" | "finish" | "repoIds" | "privacy">, setup: Setup | undefined): FinishView | undefined {
  const finish = item.finish;
  if (item.outcome?.kind !== "done" || finish === undefined) return undefined;
  const base = baseBranchOf(item, setup);
  const lines: { mark: Mark; text: string }[] = [];
  if (finish.merged !== undefined) lines.push({ mark: { symbol: "✓", word: "merged", tone: "pass" }, text: `Merged into ${finish.merged.baseBranch} · ${finish.merged.commit.slice(0, 7)}` });
  if (finish.pullRequest !== undefined) lines.push({ mark: { symbol: "↗", word: "pull request", tone: "pass" }, text: `Pull request opened: ${finish.pullRequest.url}` });
  if (finish.worktreeRemoved) lines.push({ mark: { symbol: "■", word: "removed", tone: "muted" }, text: finish.merged === undefined ? "Discarded: the worktree and branch are removed." : "The worktree and branch are removed." });
  if (finish.detail !== undefined) lines.push({ mark: { symbol: "!", word: "note", tone: "warn" }, text: finish.detail });
  if (finish.failed !== undefined) lines.push({ mark: { symbol: "✕", word: "failed", tone: "fail" }, text: `${ACTION_WORD[finish.failed.action]} did not finish: ${finish.failed.detail}` });
  const running = finish.running === undefined ? undefined : { merge: `Merging into ${base}`, pull_request: "Pushing the branch and opening a pull request", discard: "Removing the worktree and branch" }[finish.running];
  const buttons = finishActions(item).map((action): FinishButton => {
    if (action === "merge") return { action, label: `Merge into ${base}` };
    if (action === "discard") return { action, label: "Discard" };
    const unavailable = prUnavailable(item, setup);
    return { action, label: "Open PR", ...(unavailable !== undefined && { unavailable }) };
  });
  const pushNote = finish.pushTarget !== undefined && buttons.some((b) => b.action === "pull_request" && b.unavailable === undefined) ? `Open PR pushes to ${finish.pushTarget}` : undefined;
  return { lines, ...(running !== undefined && { running }), buttons, ...(pushNote !== undefined && { pushNote }) };
}

/** A short line for the list row once a finish action ran or runs; undefined otherwise. */
export function finishNote(item: Pick<ItemRecord, "finish">): string | undefined {
  const finish = item.finish;
  if (finish === undefined) return undefined;
  if (finish.running !== undefined) return `${ACTION_WORD[finish.running]} running`;
  if (finish.merged !== undefined) return `✓ merged into ${finish.merged.baseBranch}`;
  if (finish.pullRequest !== undefined) return "↗ pull request opened";
  if (finish.worktreeRemoved) return "■ discarded";
  if (finish.failed !== undefined) return `✕ ${ACTION_WORD[finish.failed.action]} did not finish`;
  return undefined;
}
