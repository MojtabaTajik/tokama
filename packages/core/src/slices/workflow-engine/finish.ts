// Finish actions on a done item: merge its commit into the base branch, open a pull request, or
// discard its worktree and branch. Each is a change outside the worktree, so it runs only on the
// engineer's own command, and Tokama runs it itself, never inside an agent call.
//
// The log is the state: `finish_started` is written before anything is touched, and a result
// event (merged, pr_opened, discarded or finish_failed) after. A start that finds an action
// recorded as running (the engine stopped during it) records it as interrupted; every action can
// simply run again. Actions on one repo run one at a time, since a merge moves the engineer's
// checkout. Details never hold this machine's paths or a remote's user info.
import { homedir, tmpdir } from "node:os";
import type { Git } from "../../kernel/git/index.js";
import type { ProcessRunner } from "../../kernel/process/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { type CommandErrorCode, type FinishAction, type ItemEventBody, type ItemId, type RepoId, type StoredItem } from "../../kernel/schemas/index.js";
import type { Repo } from "../config/index.js";
import type { ItemStore } from "../items/index.js";
import { discardWorktree, hostedRepo, mergeItem, openPullRequest, pushItem, withoutUserInfo, type ItemWorktree } from "../worktrees/index.js";

export interface FinishDeps {
  readonly store: ItemStore;
  readonly git: Git;
  /** Runs gh. */
  readonly runner: ProcessRunner;
  readonly repo: (id: RepoId) => Repo | undefined;
  /** argv that starts gh. Default: `["gh"]`. */
  readonly ghCommand?: readonly [string, ...string[]];
  /** The SSH agent socket, given to a push to an SSH remote and to nothing else. */
  readonly sshAuthSock?: string;
  /** Nothing leaves the machine: Open PR is refused. */
  readonly localOnly?: boolean;
}

export interface FinishError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

export interface Finisher {
  /** Records the start and runs the action in the background; its result comes as item events. */
  start(itemId: ItemId, action: FinishAction): Result<null, FinishError>;
  /** For a restart: actions recorded as running, on items this host owns, end as interrupted. */
  recover(): void;
  /** Settles once the item's action has ended. */
  settled(itemId: ItemId): Promise<void>;
  /** Refuses new actions and waits for the running ones. */
  close(): Promise<void>;
}

const DETAIL_MAX = 500;
const LABEL: Record<FinishAction, string> = { merge: "Merge", pull_request: "Open PR", discard: "Discard" };

export function createFinisher(deps: FinishDeps): Finisher {
  const { store, git } = deps;
  const running = new Map<ItemId, Promise<void>>();
  const repoChains = new Map<RepoId, Promise<void>>();
  let closing = false;

  const fail = (code: CommandErrorCode, message: string): Result<never, FinishError> => err({ code, message });

  const scrub = (text: string, repo: Repo | undefined): string => {
    const roots: [string, string][] = [...(repo === undefined ? [] : [[repo.path, `<repo ${repo.id}>`] as [string, string]]), [tmpdir(), "<tmp>"], [homedir(), "~"]];
    const out = roots.filter(([path]) => path.length > 1).reduce((acc, [path, name]) => acc.split(path).join(name), withoutUserInfo(text));
    const line = out.replace(/\s+/g, " ").trim() || "(no detail)";
    return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
  };

  const append = (itemId: ItemId, events: readonly ItemEventBody[]) => {
    const appended = store.append(itemId, events);
    if (!appended.ok) throw new Error(`cannot record ${events.map((e) => e.type).join(", ")}: ${appended.error.message}`);
  };

  /** Why the action can't start now, in plain words; undefined when it can. */
  const refusal = (item: StoredItem, action: FinishAction, repo: Repo | undefined): Result<never, FinishError> | undefined => {
    if (item.outcome?.kind !== "done") return fail("invalid_state", "Only a done item can be merged, opened as a pull request or discarded.");
    if (item.worktrees[0] === undefined) return fail("invalid_state", "The item has no worktree.");
    const finish = item.finish;
    if (finish?.running !== undefined) return fail("invalid_state", `${LABEL[finish.running]} is still running.`);
    if (finish?.worktreeRemoved === true) return fail("invalid_state", "The item's worktree and branch are gone already.");
    if (action !== "discard") {
      if ((item.outcome.commits?.length ?? 0) === 0) return fail("invalid_state", "The item made no commit, so there is nothing to merge or push.");
      if (finish?.merged !== undefined) return fail("invalid_state", "The item is merged already.");
      if (finish?.pullRequest !== undefined) return fail("invalid_state", "The item has a pull request already.");
    }
    if (repo === undefined) return fail("not_found", `Repo ${item.repoIds[0] ?? "(none)"} is not set up on this machine. Add it, then try again.`);
    if (action === "pull_request") {
      if (deps.localOnly === true) return fail("invalid_request", "Local-only mode is on: nothing leaves this machine, so Tokama does not push.");
      const pushUrl = item.worktrees[0].pushUrl;
      if (pushUrl === undefined || hostedRepo(pushUrl) === undefined) {
        return fail("invalid_request", "When the item started, the repo had no origin remote on a code host, so Tokama has nowhere to push it.");
      }
    }
    return undefined;
  };

  /** The action itself; its result as the one event that ends it. */
  const perform = async (item: StoredItem, action: FinishAction, repo: Repo): Promise<ItemEventBody> => {
    const recorded = item.worktrees[0]!;
    const worktree: ItemWorktree = { branch: recorded.branch, folder: recorded.dir, baseCommit: recorded.baseCommit ?? "" };
    const commit = item.outcome?.commits?.find((c) => c.repoId === repo.id)?.commit ?? item.outcome?.commits?.[0]?.commit;
    const failed = (detail: string): ItemEventBody => ({ type: "finish_failed", action, detail: scrub(detail, repo) });
    switch (action) {
      case "merge": {
        const merged = await mergeItem(git, repo, worktree, { id: item.id, title: item.title, commit: commit! });
        if (!merged.ok) return failed(merged.error);
        const { detail } = merged.value;
        return {
          type: "merged",
          repoId: repo.id,
          baseBranch: repo.baseBranch,
          commit: merged.value.commit,
          worktreeRemoved: merged.value.worktreeRemoved,
          ...(detail !== undefined && { detail: scrub(detail, repo) }),
        };
      }
      case "pull_request": {
        const pushUrl = recorded.pushUrl!;
        const hosted = hostedRepo(pushUrl)!;
        const pushed = await pushItem(git, repo.path, {
          commit: commit!,
          branch: worktree.branch,
          pushUrl,
          ...(hosted.ssh && deps.sshAuthSock !== undefined && { sshAuthSock: deps.sshAuthSock }),
        });
        if (!pushed.ok) return failed(pushed.error);
        const opened = await openPullRequest(
          { runner: deps.runner, ...(deps.ghCommand !== undefined && { command: deps.ghCommand }) },
          { repo: hosted, itemId: item.id, title: item.title, head: worktree.branch, base: repo.baseBranch },
        );
        return opened.ok ? { type: "pr_opened", repoId: repo.id, url: opened.value } : failed(opened.error);
      }
      case "discard": {
        const discarded = await discardWorktree(git, repo.path, worktree);
        return discarded.ok ? { type: "discarded", repoId: repo.id } : failed(`Cannot remove the worktree and branch: ${discarded.error.message}`);
      }
    }
  };

  return {
    start(itemId, action) {
      if (closing) return fail("invalid_state", "The engine is shutting down.");
      const item = store.get(itemId);
      if (item === undefined || item.deleted) return fail("not_found", `No item ${itemId}.`);
      const repoId = item.repoIds[0];
      const repo = repoId === undefined ? undefined : deps.repo(repoId);
      const refused = refusal(item, action, repo);
      if (refused !== undefined) return refused;
      const started = store.append(itemId, [{ type: "finish_started", action }]);
      if (!started.ok) return fail("invalid_state", started.error.message);
      const chain = (repoChains.get(repo!.id) ?? Promise.resolve()).then(async () => {
        let result: ItemEventBody;
        try {
          result = await perform(started.value, action, repo!);
        } catch (error) {
          result = { type: "finish_failed", action, detail: scrub(`Tokama hit an error: ${error instanceof Error ? error.message : String(error)}`, repo) };
        }
        try {
          append(itemId, [result]);
        } catch {
          // Nothing more can be recorded; the next start records the action as interrupted.
        }
      });
      repoChains.set(repo!.id, chain);
      running.set(itemId, chain);
      void chain.finally(() => {
        if (running.get(itemId) === chain) running.delete(itemId);
        if (repoChains.get(repo!.id) === chain) repoChains.delete(repo!.id);
      });
      return ok(null);
    },

    recover() {
      for (const item of store.list()) {
        const action = item.finish?.running;
        if (action === undefined || item.deleted || item.hostId !== store.hostId) continue;
        append(item.id, [
          { type: "finish_failed", action, detail: `The engine stopped while ${LABEL[action]} ran. It may have done part of it; try again to finish it.` },
        ]);
      }
    },

    async settled(itemId) {
      await running.get(itemId);
    },

    async close() {
      closing = true;
      await Promise.allSettled([...running.values()]);
    },
  };
}
