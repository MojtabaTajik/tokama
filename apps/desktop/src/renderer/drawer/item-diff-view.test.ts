import type { ItemChange, ItemRecord, RepoId } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { committed, finishable } from "../testing/drawer.js";
import { diffHeader, type DiffHeader, showsChange } from "./item-diff-view.js";

const REPO = "orders-api" as RepoId;
const BASE = "85a75e3c0ffee0000000000000000000000000ab";
const MERGED = "abc1234def5678900000000000000000000000ff";
const file = (path: string, added: number | null, removed: number | null) => ({ path, status: "modified" as const, added, removed, binary: added === null, cut: added === null, hunks: [] });
const FILES = [file("src/receipt/format.js", 1230, 300), file("README.md", 14, 16), file("assets/logo.png", null, null)];
const worktree: ItemChange = { kind: "worktree", files: FILES, moreFiles: 2, cut: true, worktree: { repoId: REPO, dir: ".tokama/wt/receipt", branch: "tokama/receipt-tax", baseCommit: BASE } };
const merged: ItemChange = { kind: "merged", files: FILES, moreFiles: 2, cut: true, repoId: REPO, baseBranch: "main", commit: MERGED, parent: BASE };

const flat = (parts: readonly (string | { code: string })[]) => parts.map((part) => (typeof part === "string" ? part : part.code)).join("");
/** The header as the screen reads it: the symbol, the first line, the second line. */
const lines = (header: DiffHeader | undefined) => {
  if (header === undefined) throw new Error("expected a header");
  return [`${header.mark.symbol} ${[flat(header.head), ...header.details.map(flat)].join(" · ")}`, header.sub];
};
const loaded = (change: ItemChange) => ({ kind: "loaded", change }) as const;
const withState = (state: ItemRecord["state"], finish?: ItemRecord["finish"]) => ({ ...finishable, state, finish }) as ItemRecord;

describe("diffHeader", () => {
  it("done, not merged: where the branch is and the merge-base it is compared with", () => {
    const header = diffHeader(finishable, loaded(worktree), "main");
    expect(lines(header)).toEqual(["○ Not merged yet · branch tokama/receipt-tax · 5 files, +1,244 −316", "Compared with main at 85a75e3, where the item started."]);
    expect(header?.mark.tone).toBe("muted");
    expect(header?.columns).toEqual({ before: "Before · main 85a75e3", after: "After · tokama/receipt-tax" });
  });

  it("merging: while Merge runs, and while the merged item's change is still the one from before", () => {
    const first = "● Merging into main… · branch tokama/receipt-tax · 5 files, +1,244 −316";
    const sub = "Compared with main at 85a75e3, where the item started.";
    const running = diffHeader(withState("done", { worktreeRemoved: false, running: "merge" }), loaded(worktree), "main");
    expect(lines(running)).toEqual([first, sub]);
    expect(running?.mark.tone).not.toBe("pass");
    expect(running?.mark.tone).not.toBe("fail");
    expect(running?.columns).toEqual({ before: "Before · main 85a75e3", after: "After · tokama/receipt-tax" });
    const done = withState("done", { worktreeRemoved: true, merged: { baseBranch: "main", commit: MERGED } });
    expect(lines(diffHeader(done, loaded(worktree), "main"))).toEqual([first, sub]);
    const refused = withState("done", { worktreeRemoved: false, failed: { action: "merge", reason: "conflict", detail: "src/a.ts" } } as ItemRecord["finish"]);
    expect(lines(diffHeader(refused, loaded(worktree), "main"))[0]).toBe("○ Not merged yet · branch tokama/receipt-tax · 5 files, +1,244 −316");
  });

  it("done with nothing committed: says so, and marks the edits as uncommitted", () => {
    const expected = ["○ Nothing was committed · worktree tokama/receipt-tax · 5 files, +1,244 −316", "Uncommitted changes left in the worktree, compared with main at 85a75e3."];
    for (const outcome of [{ kind: "done" }, { kind: "done", commits: [] }]) {
      const header = diffHeader({ ...finishable, outcome } as ItemRecord, loaded(worktree), "main");
      expect(lines(header)).toEqual(expected);
      expect(header?.columns).toEqual({ before: "Before · main 85a75e3", after: "After · worktree" });
      expect(showsChange({ ...finishable, outcome } as ItemRecord, loaded(worktree))).toBe(true);
    }
  });

  it("PR open: the pull request, with the same diff", () => {
    const pr = withState("done", { worktreeRemoved: false, pullRequest: { url: "https://github.com/northwind/orders-api/pull/12" } });
    expect(lines(diffHeader(pr, loaded(worktree), "main"))).toEqual(["↗ PR #12 open · branch tokama/receipt-tax · 5 files, +1,244 −316", "Compared with main at 85a75e3, where the item started."]);
  });

  it("merged: the merged commit against the base branch before it", () => {
    const header = diffHeader(withState("done", { worktreeRemoved: true, merged: { baseBranch: "main", commit: MERGED } }), loaded(merged), "main");
    expect(lines(header)).toEqual(["✓ Merged as abc1234 into main · 5 files, +1,244 −316", "The merged commit compared with main before it."]);
    expect(header?.columns).toEqual({ before: "Before · main 85a75e3", after: "After · abc1234" });
  });

  it("a merged commit that is gone: says so without an error tone, and has no columns", () => {
    const header = diffHeader(withState("done", { worktreeRemoved: true, merged: { baseBranch: "main", commit: MERGED } }), loaded({ kind: "gone", repoId: REPO, commit: MERGED }), "main");
    expect(lines(header)).toEqual(["– Commit abc1234 is no longer in the repo", "History was rewritten after the merge, so there is nothing to compare."]);
    expect(header?.mark.tone).toBe("muted");
    expect(header?.columns).toBeUndefined();
  });

  it("a commit that is gone from an item that was not merged does not speak of a merge", () => {
    const header = diffHeader(finishable, loaded({ kind: "gone", repoId: REPO, commit: MERGED }), "main");
    expect(lines(header)).toEqual(["– Commit abc1234 is no longer in the repo", "The branch was deleted and git removed the commit, so there is nothing to compare."]);
  });

  it("stopped and failed with their worktree left", () => {
    const one = { ...worktree, files: [file("src/db/pool.ts", 40, 6)], moreFiles: 0 } as ItemChange;
    expect(lines(diffHeader(withState("stopped"), loaded(one), "main"))).toEqual(["■ Not merged · stopped · worktree tokama/receipt-tax · 1 file, +40 −6", "Compared with main at 85a75e3, where the item started."]);
    expect(lines(diffHeader(withState("failed"), loaded(one), undefined))).toEqual(["✕ Not merged · failed · worktree tokama/receipt-tax · 1 file, +40 −6", "Compared with the base branch at 85a75e3, where the item started."]);
  });

  it("discarded: one line, no diff; nothing to compare: no header", () => {
    expect(lines(diffHeader(finishable, { kind: "discarded" }, "main"))).toEqual(["⊘ Discarded · the branch and its changes were deleted", undefined]);
    expect(diffHeader(finishable, loaded({ kind: "none" }), "main")).toBeUndefined();
  });
});

describe("showsChange", () => {
  const plain = { ...finishable, outcome: { kind: "done" } } as ItemRecord;
  it("shows for files, a merge, a gone commit and a discard; never while loading or for an item that changed nothing", () => {
    expect(showsChange(finishable, loaded(worktree))).toBe(true);
    expect(showsChange(finishable, loaded(merged))).toBe(true);
    expect(showsChange(finishable, loaded({ kind: "gone", repoId: REPO, commit: MERGED }))).toBe(true);
    expect(showsChange(finishable, { kind: "discarded" })).toBe(true);
    expect(showsChange(finishable, { kind: "loading" })).toBe(false);
    expect(showsChange(finishable, undefined)).toBe(false);
    expect(showsChange(plain, loaded({ kind: "none" }))).toBe(false);
    expect(showsChange(plain, loaded({ ...worktree, files: [], moreFiles: 0 } as ItemChange))).toBe(false);
  });

  it("a change that cannot be read shows only for an item with a commit or a merge", () => {
    expect(showsChange(committed, { kind: "failed", message: "boom" })).toBe(true);
    expect(showsChange(plain, { kind: "failed", message: "boom" })).toBe(false);
    expect(showsChange({ ...plain, finish: { worktreeRemoved: true, merged: { baseBranch: "main", commit: MERGED } } } as ItemRecord, { kind: "failed", message: "boom" })).toBe(true);
  });
});
