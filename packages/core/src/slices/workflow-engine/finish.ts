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
import { join } from "node:path";
import { readTextFile, replaceTextSync } from "../../kernel/fs-safe/index.js";
import type { Git } from "../../kernel/git/index.js";
import type { ProcessRunner } from "../../kernel/process/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { newerTemplateRecordMessage, parseTemplateRecord, type CommandErrorCode, type FinishAction, type FinishRefusal, type GitChange, type ItemEventBody, type ItemId, type RepoId, type StoredItem } from "../../kernel/schemas/index.js";
import { cutText, scrubPaths } from "../../kernel/text/index.js";
import type { Repo } from "../config/index.js";
import { sharedGitHashes, sharedGitSettings, type GitSetting, type TamperChange } from "../integrity/index.js";
import type { ItemStore } from "../items/index.js";
import { digestOf, steeringChanges, steeringEntries, type SteeringEntry } from "./protect.js";
import { discardWorktree, ghStatus, hostedRepo, mergeItem, openPullRequest, pushItem, withoutUserInfo, type ItemWorktree } from "../worktrees/index.js";

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
  /** Nothing leaves the machine for any item: Open PR is refused. Local-only items refuse it on their own. */
  readonly localOnly?: boolean;
}

export interface FinishError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

export interface Finisher {
  /** Records the start and runs the action in the background; its result comes as item events. */
  start(itemId: ItemId, action: FinishAction): Result<null, FinishError>;
  /** Takes the git config and hooks a Finish action was refused for as the item's new baseline. */
  acceptGitChanges(itemId: ItemId): Promise<Result<null, FinishError>>;
  /** For a restart: actions recorded as running, on items this host owns, end as interrupted. */
  recover(): void;
  /** Settles once the item's action has ended. */
  settled(itemId: ItemId): Promise<void>;
  /** Refuses new actions and waits for the running ones. */
  close(): Promise<void>;
}

const DETAIL_MAX = 500;
/** The steering baseline the run loop writes beside the item's log at Start, and the git settings kept with it. */
const BASELINE_FILE = "baseline.json";
export const GIT_SETTINGS_FILE = "baseline-git.json";
const VALUE_MAX = 160;
const CHANGES_MAX = 30;

type GitSettings = { readonly settings: readonly GitSetting[]; readonly hooks: Readonly<Record<string, string>> };
interface SteeringRefusal {
  readonly detail: string;
  readonly reason?: FinishRefusal;
  readonly changes?: GitChange[];
  readonly gitDigest?: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const read = await readTextFile(path, { maxBytes: 4 * 1024 * 1024 });
  if (!read.ok) return undefined;
  try {
    return JSON.parse(read.value) as T;
  } catch {
    return undefined;
  }
}

/** A value on one line, cut to fit. */
const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return cutText(line, VALUE_MAX);
};

/**
 * What changed, setting by setting and hook by hook when the settings from the baseline were kept;
 * otherwise by file. Values are text, on one line, cut to fit.
 */
export function describeGitChanges(changed: readonly TamperChange[], before: GitSettings | undefined, after: GitSettings | undefined): GitChange[] {
  const out: GitChange[] = [];
  const settingsOf = (snapshot: GitSettings, file: string) => {
    const map = new Map<string, string[]>();
    for (const s of snapshot.settings) if (s.file === file) map.set(s.key, [...(map.get(s.key) ?? []), s.value ?? "true"]);
    return map;
  };
  for (const change of changed) {
    const file = change.path;
    if (before !== undefined && after !== undefined && (file === "config" || file === "config.worktree")) {
      const was = settingsOf(before, file);
      const now = settingsOf(after, file);
      const listed = out.length;
      for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
        const a = was.get(key)?.join(", ");
        const b = now.get(key)?.join(", ");
        if (a === b) continue;
        out.push({ what: `setting ${key}${file === "config" ? "" : ` in ${file}`}`, ...(a !== undefined && { before: oneLine(a) }), ...(b !== undefined && { after: oneLine(b) }) });
      }
      // A change only in a file the config includes.
      if (out.length === listed) out.push({ what: `${file} (a file it includes)` });
      continue;
    }
    if (file.startsWith("hooks/")) {
      const a = before?.hooks[file];
      const b = after?.hooks[file];
      out.push({ what: `hook ${file.slice("hooks/".length)} ${change.change}`, ...(a !== undefined && { before: oneLine(a) }), ...(b !== undefined && { after: oneLine(b) }) });
      continue;
    }
    out.push({ what: `${file} ${change.change}` });
  }
  return out.length > CHANGES_MAX ? [...out.slice(0, CHANGES_MAX - 1), { what: `and ${out.length - CHANGES_MAX + 1} more changes` }] : out;
}

/**
 * The entries of the shared git dir: its config, info files and hooks. They steer a merge and a
 * push in the engineer's checkout as much as Tokama's own calls; the worktree's own entries are
 * left out, since the worktree may be gone by now.
 */
const shared = (entries: readonly SteeringEntry[]) =>
  entries.filter((e) => e.area === "git" && e.category === "git" && e.path !== "HEAD" && !e.path.startsWith("worktrees/") && !e.path.startsWith("refs/"));
const LABEL: Record<FinishAction, string> = { merge: "Merge", pull_request: "Open PR", discard: "Discard" };

export function createFinisher(deps: FinishDeps): Finisher {
  const { store, git } = deps;
  const running = new Map<ItemId, Promise<void>>();
  const repoChains = new Map<RepoId, Promise<void>>();
  let closing = false;

  const fail = (code: CommandErrorCode, message: string): Result<never, FinishError> => err({ code, message });

  const scrub = (text: string, repo: Repo | undefined): string => {
    const roots: [string, string][] = [...(repo === undefined ? [] : [[repo.path, `<repo ${repo.id}>`] as [string, string]]), [tmpdir(), "<tmp>"], [homedir(), "~"]];
    const out = scrubPaths(withoutUserInfo(text), { roots });
    const line = out.replace(/\s+/g, " ").trim() || "(no detail)";
    return cutText(line, DETAIL_MAX);
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
      // The item's own template, as it started: a template whose steps send nothing out makes a
      // local-only item, and its work stays here too. An unreadable snapshot counts as local only.
      const template = parseTemplateRecord(item.template.record);
      if (!template.ok && template.error.newerVersion !== undefined) return fail("invalid_request", newerTemplateRecordMessage(template.error.newerVersion));
      if (!template.ok || template.value.steps.every((step) => step.data === "none")) {
        return fail("invalid_request", "This item is local only: its template lets nothing leave this machine, so Tokama does not push its work.");
      }
      const pushUrl = item.worktrees[0].pushUrl;
      if (pushUrl === undefined || hostedRepo(pushUrl) === undefined) {
        return fail("invalid_request", "When the item started, the repo had no origin remote on a code host, so Tokama has nowhere to push it.");
      }
    }
    return undefined;
  };

  /** The item's baseline: the steering entries the log's digest names, and the git settings kept with them. */
  const loadBaseline = async (item: StoredItem): Promise<{ entries: SteeringEntry[]; settings: GitSettings | undefined } | undefined> => {
    const digest = item.worktrees[0]?.protectedDigest;
    if (digest === undefined) return undefined;
    const dir = store.itemDir(item.id);
    // At Start the run loop writes baseline.json; each accepted change adds files named by digest.
    for (const [file, settingsFile] of [[BASELINE_FILE, GIT_SETTINGS_FILE], [`baseline-${digest}.json`, `baseline-git-${digest}.json`]] as const) {
      const entries = await readJson<SteeringEntry[]>(join(dir, file));
      if (!Array.isArray(entries) || digestOf(entries) !== digest) continue;
      return { entries, settings: await readJson<GitSettings>(join(dir, settingsFile)) };
    }
    return undefined;
  };

  /**
   * Why git's own config or hooks can't be trusted now: they differ from the item's baseline (with
   * what changed), or the baseline can't be read. Undefined when they match.
   */
  const steeringChanged = async (item: StoredItem, repo: Repo, worktree: ItemWorktree): Promise<SteeringRefusal | undefined> => {
    const baseline = await loadBaseline(item);
    if (baseline === undefined) {
      return { detail: "Tokama has no readable record of the repo's git config and hooks from when the item started, so it does not merge or push it." };
    }
    const hashes = await sharedGitHashes(git, repo.path);
    if (!hashes.ok) return { detail: `Cannot read the repo's git config and hooks: ${hashes.error.message}` };
    const now = shared(steeringEntries(hashes.value, worktree.branch));
    const changed = steeringChanges(shared(baseline.entries), now);
    if (changed.length === 0) return undefined;
    const settings = await sharedGitSettings(git, repo.path);
    return {
      detail: "The repo's git config or hooks changed since the item started. Tokama merges or pushes only with the ones it started with, or with changes you say you made.",
      reason: "steering_changed",
      changes: describeGitChanges(changed, baseline.settings, settings.ok ? settings.value : undefined),
      gitDigest: digestOf(now),
    };
  };

  /** The action itself; its result as the one event that ends it. */
  const perform = async (item: StoredItem, action: FinishAction, repo: Repo): Promise<ItemEventBody> => {
    const recorded = item.worktrees[0]!;
    const worktree: ItemWorktree = { branch: recorded.branch, folder: recorded.dir, baseCommit: recorded.baseCommit ?? "" };
    const commit = item.outcome?.commits?.find((c) => c.repoId === repo.id)?.commit ?? item.outcome?.commits?.[0]?.commit;
    const failed = (detail: string, reason?: FinishRefusal, extra: { changes?: GitChange[]; gitDigest?: string } = {}): ItemEventBody => ({
      type: "finish_failed",
      action,
      detail: scrub(detail, repo),
      ...(reason !== undefined && { reason }),
      ...(extra.changes !== undefined && { changes: extra.changes.map((c) => ({ what: c.what, ...(c.before !== undefined && { before: scrub(c.before, repo) }), ...(c.after !== undefined && { after: scrub(c.after, repo) }) })) }),
      ...(extra.gitDigest !== undefined && { gitDigest: extra.gitDigest }),
    });
    if (action !== "discard") {
      const changed = await steeringChanged(item, repo, worktree);
      if (changed !== undefined) {
        return failed(changed.detail, changed.reason, {
          ...(changed.changes !== undefined && { changes: changed.changes }),
          ...(changed.gitDigest !== undefined && { gitDigest: changed.gitDigest }),
        });
      }
    }
    switch (action) {
      case "merge": {
        const merged = await mergeItem(git, repo, worktree, { id: item.id, title: item.title, commit: commit! });
        if (!merged.ok) return failed(merged.error.message, merged.error.reason);
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
        const gh = { runner: deps.runner, ...(deps.ghCommand !== undefined && { command: deps.ghCommand }) };
        // Nothing is pushed unless gh can open the pull request on that host afterwards.
        const ready = await ghStatus(gh, hosted.host);
        if (!ready.loggedIn) return failed(`Nothing was pushed. ${ready.message ?? "gh cannot open pull requests now."}`);
        const pushed = await pushItem(git, repo.path, {
          commit: commit!,
          branch: worktree.branch,
          pushUrl,
          ...(deps.sshAuthSock !== undefined && { sshAuthSock: deps.sshAuthSock }),
        });
        if (!pushed.ok) return failed(pushed.error);
        const opened = await openPullRequest(gh, { repo: hosted, itemId: item.id, title: item.title, head: worktree.branch, base: repo.baseBranch });
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
          // An action still queued behind another when the engine shuts down does not start.
          result = closing ? { type: "finish_failed", action, detail: `The engine stopped before ${LABEL[action]} ran; nothing was done. Try again.` } : await perform(started.value, action, repo!);
        } catch (error) {
          result = { type: "finish_failed", action, detail: scrub(`Tokama hit an error: ${error instanceof Error ? error.message : String(error)}`, repo) };
        }
        try {
          append(itemId, [result]);
        } catch (error) {
          // The result did not fit or could not be written: end the action as failed, so the item
          // does not stay "running". If even that fails, the next start records it as interrupted.
          const detail = scrub(`Tokama could not record the result of ${LABEL[action]}: ${error instanceof Error ? error.message : String(error)}`, repo);
          store.append(itemId, [{ type: "finish_failed", action, detail }]);
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

    async acceptGitChanges(itemId) {
      if (closing) return fail("invalid_state", "The engine is shutting down.");
      const item = store.get(itemId);
      if (item === undefined || item.deleted) return fail("not_found", `No item ${itemId}.`);
      const failure = item.finish?.failed;
      if (item.finish?.running !== undefined) return fail("invalid_state", `${LABEL[item.finish.running]} is still running.`);
      if (failure?.reason !== "steering_changed" || failure.gitDigest === undefined) return fail("invalid_state", "No Finish action was refused for changed git config or hooks.");
      const recorded = item.worktrees[0];
      const repo = item.repoIds[0] === undefined ? undefined : deps.repo(item.repoIds[0]);
      if (recorded === undefined || repo === undefined) return fail("not_found", `Repo ${item.repoIds[0] ?? "(none)"} is not set up on this machine.`);
      const [baseline, hashes, settings] = await Promise.all([loadBaseline(item), sharedGitHashes(git, repo.path), sharedGitSettings(git, repo.path)]);
      if (baseline === undefined) return fail("invalid_state", "Tokama has no readable record of the item's baseline.");
      if (!hashes.ok || !settings.ok) return fail("invalid_state", `Cannot read the repo's git config and hooks: ${(hashes.ok ? (settings as { error: { message: string } }).error : hashes.error).message}`);
      const now = shared(steeringEntries(hashes.value, recorded.branch));
      // What the engineer saw is what they accept: a later change is listed first.
      if (digestOf(now) !== failure.gitDigest) return fail("stale_decision", "The git config or hooks changed again since Tokama listed them. Try the action again to see what changed.");
      const sharedKeys = new Set(shared(baseline.entries).map((e) => e.key));
      const entries = [...baseline.entries.filter((e) => !sharedKeys.has(e.key)), ...now].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const digest = digestOf(entries);
      const dir = store.itemDir(itemId);
      // Written before the event that names them, under their digest: nothing is rewritten.
      for (const [name, value] of [[`baseline-${digest}.json`, entries], [`baseline-git-${digest}.json`, settings.value]] as const) {
        const written = replaceTextSync(join(dir, name), `${JSON.stringify(value)}\n`, 0o600);
        if (!written.ok) throw new Error(written.error.message);
      }
      const appended = store.append(itemId, [{ type: "git_changes_accepted", repoId: recorded.repoId, protectedDigest: digest }]);
      return appended.ok ? ok(null) : fail("invalid_state", appended.error.message);
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
