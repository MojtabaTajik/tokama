// A step's agent can write the repo's shared git data (a commit needs that), so it could move a
// branch or tag that belongs to other work. The engine lists the repo's branches and tags before
// the call and compares them after it; the item's own branch may move. Refs that Tokama itself
// writes meanwhile (another item's branch made, committed, merged or discarded) are not the agent's:
// the ledger takes the value Tokama wrote as the new start, unless the ref had already moved.
import type { Git } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";

const BRANCH = "refs/heads/";
const TAG = "refs/tags/";

export const branchRef = (branch: string) => `${BRANCH}${branch}`;

/** What differs between two ref lists, leaving out `ignored`, sorted: "branch main changed", "tag v1 was deleted", "branch side was created". */
export function movedRefs(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, ignored: ReadonlySet<string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((name) => !ignored.has(name) && before.get(name) !== after.get(name))
    .sort()
    .map((name) => {
      const what = name.startsWith(BRANCH) ? `branch ${name.slice(BRANCH.length)}` : `tag ${name.slice(TAG.length)}`;
      return `${what} ${before.has(name) ? (after.has(name) ? "changed" : "was deleted") : "was created"}`;
    });
}

/** The text of the stop: what happened, whatever the cause; nothing was undone. */
export function movedRefsText(changes: readonly string[]): string {
  const [only] = changes;
  const what =
    changes.length === 1 && only !== undefined
      ? `${only.charAt(0).toUpperCase()}${only.slice(1)} during this step`
      : `During this step, ${changes.slice(0, 5).join("; ")}${changes.length > 5 ? `; and ${changes.length - 5} more` : ""}`;
  return `${what}. Tokama stopped the item; nothing was undone.`;
}

export interface RefWatch {
  /** The branches and tags that changed since the watch began (see `movedRefs`); an error when git cannot list them. */
  moved(): Promise<Result<string[], string>>;
  close(): void;
}

export interface RefLedger {
  /** Starts watching a repo's branches and tags; the item's own branch is left out. */
  watch(repoPath: string, ownBranch: string): Promise<Result<RefWatch, string>>;
  /**
   * Runs a write that Tokama makes to `refs` itself. Watches on the repo take the written values
   * as their start, except for a ref that had moved already: that stays reported. Known limit: a
   * write by an agent to that same ref during the few moments of Tokama's own write is taken as
   * Tokama's. Writes on one repo run in turn, and the watches list only between them, so a write
   * must not call `around` or a watch on the same repo.
   */
  around<T>(repoPath: string, refs: readonly string[], write: () => Promise<T>): Promise<T>;
}

interface Watched {
  readonly before: Map<string, string>;
}

export function createRefLedger(git: Git): RefLedger {
  const open = new Map<string, Set<Watched>>();
  /** Tokama's writes on a repo run one after the other; this is the last one queued (it never rejects). */
  const tails = new Map<string, Promise<unknown>>();
  /** The repo's refs while none of Tokama's writes is running: a listing in the middle of one would blame the step for it. */
  const listWhenQuiet = async (repoPath: string) => {
    for (;;) {
      const tail = tails.get(repoPath);
      await tail;
      const listed = await git.refs(repoPath);
      if (tails.get(repoPath) === tail) return listed;
    }
  };
  return {
    async watch(repoPath, ownBranch) {
      const watched: Watched = { before: new Map() };
      const set = open.get(repoPath) ?? new Set();
      set.add(watched);
      open.set(repoPath, set);
      const close = () => void set.delete(watched);
      const listed = await listWhenQuiet(repoPath);
      if (!listed.ok) {
        close();
        return err(listed.error.message);
      }
      watched.before.clear();
      for (const [name, value] of listed.value) watched.before.set(name, value);
      const own = branchRef(ownBranch);
      return ok({
        async moved() {
          const after = await listWhenQuiet(repoPath);
          if (!after.ok) return err(after.error.message);
          const moved = movedRefs(watched.before, after.value, new Set([own]));
          // The item's own branch may move, but not into a link to another branch: a commit on it would move that one.
          if (after.value.get(own)?.includes(" -> ") === true) moved.push(`branch ${ownBranch} became a link to another branch`);
          return ok(moved);
        },
        close,
      });
    },
    around(repoPath, refs, write) {
      const run = async () => {
        const pre = await git.refs(repoPath);
        try {
          return await write();
        } finally {
          const post = await git.refs(repoPath);
          // A listing that fails leaves the watches as they are: Tokama's write may then be reported, never hidden.
          if (pre.ok && post.ok) {
            for (const watched of open.get(repoPath) ?? []) {
              for (const ref of refs) {
                if (watched.before.get(ref) !== pre.value.get(ref)) continue;
                const written = post.value.get(ref);
                if (written === undefined) watched.before.delete(ref);
                else watched.before.set(ref, written);
              }
            }
          }
        }
      };
      const queued = (tails.get(repoPath) ?? Promise.resolve()).then(run);
      tails.set(repoPath, queued.catch(() => undefined));
      return queued;
    },
  };
}
