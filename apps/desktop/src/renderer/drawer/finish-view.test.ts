import type { ItemRecord, Setup } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { committed, finishable, setup } from "../testing/drawer.js";
import { finishNote, finishState, finishView, isDiscarded, prName, type FinishView } from "./finish-view.js";

const withFinish = (finish: Partial<NonNullable<ItemRecord["finish"]>>, extra: Partial<ItemRecord> = {}): ItemRecord => ({ ...finishable, ...extra, finish: { ...finishable.finish!, ...finish } });
const withGh = (gh: NonNullable<Setup["health"]["gh"]>) => ({ ...setup, health: { ...setup.health, gh } }) as Setup;
const offer = (view: FinishView | undefined) => {
  if (view?.kind !== "offer") throw new Error(`expected the offer, got ${JSON.stringify(view)}`);
  return view;
};
const ended = (view: FinishView | undefined) => {
  if (view?.kind !== "ended") throw new Error(`expected the end, got ${JSON.stringify(view)}`);
  return view;
};
const flat = (parts: readonly (string | { code: string })[]) => parts.map((part) => (typeof part === "string" ? part : part.code)).join("");
const AT = new Date(2026, 10, 25, 14, 58).getTime();

describe("finishView: the offer", () => {
  it("names the branch, and offers Merge into the base branch, Open PR with its push target, and Discard", () => {
    const view = offer(finishView(finishable, setup));
    expect(view.branch).toBe("tokama/0b9f3c1e");
    expect(view.ahead).toBe("1 commit ahead of main");
    expect(view.rows.map((row) => [row.title, row.button.label, row.button.tone, row.button.disabled ?? false])).toEqual([
      ["Merge into main", "Merge into main", "primary", false],
      ["Open PR", "Open PR", "plain", false],
      ["Discard", "Discard…", "danger", false],
    ]);
    expect(flat(view.rows[0]!.text)).toBe("Merges into your checkout at ~/code/orders-api, then removes the worktree and the branch.");
    expect(flat(view.rows[1]!.text)).toBe("Pushes tokama/0b9f3c1e to github.com/northwind/orders-api and opens a pull request with gh. The worktree stays until the PR is merged.");
    expect(flat(view.rows[2]!.text)).toBe("Deletes the worktree and the branch. The commit is lost.");
    expect(finishView(committed, setup)).toBeUndefined();
  });

  it("offers only Discard without a commit", () => {
    const view = offer(finishView({ ...finishable, outcome: { kind: "done" } }, setup));
    expect(view.rows.map((row) => row.action)).toEqual(["discard"]);
    expect(view.ahead).toBeUndefined();
  });

  it("says each Merge refusal in place: uncommitted changes and another branch offer Try again, a conflict Open PR instead", () => {
    const refused = (reason: "dirty_checkout" | "other_branch" | "conflict" | "files_in_the_way") =>
      offer(finishView(withFinish({ failed: { action: "merge", reason, detail: "detail words" } }), setup)).rows[0]!;
    expect(refused("dirty_checkout")).toMatchObject({ notice: { headline: "Your checkout has uncommitted changes.", body: "detail words" }, button: { label: "Try again", action: "merge" } });
    expect(refused("other_branch")).toMatchObject({ notice: { headline: "Your checkout is on another branch." }, button: { label: "Try again" } });
    expect(refused("conflict")).toMatchObject({ notice: { headline: "main has moved and the merge has conflicts." }, button: { label: "Open PR instead", action: "pull_request" } });
    expect(refused("files_in_the_way")).toMatchObject({ notice: { headline: "Your checkout has files where the merge writes." } });
    const pr = offer(finishView(withFinish({ failed: { action: "pull_request", detail: "gh said no" } }), setup)).rows[1]!;
    expect(pr).toMatchObject({ notice: { headline: "Open PR did not finish.", body: "gh said no" }, button: { label: "Try again" } });
  });

  it("turns Open PR off with the reason and the fix: gh missing, logged out, no origin, local only", () => {
    const pr = (item: ItemRecord, s: Setup) => offer(finishView(item, s)).rows[1]!;
    const missing = pr(finishable, withGh({ installed: false, loggedIn: false }));
    expect([flat(missing.text), flat(missing.off!.status), missing.off!.recheck, missing.button.disabled]).toEqual(["Needs the GitHub CLI (gh). It was not found on your PATH.", "✕ gh not found · install it from cli.github.com", true, true]);
    const out = pr(finishable, withGh({ installed: true, loggedIn: false }));
    expect([flat(out.text), flat(out.off!.status)]).toEqual(["gh is installed but not logged in.", "✕ logged out · run gh auth login in a terminal"]);
    const noOrigin = pr(withFinish({ pushTarget: undefined }), setup);
    expect([flat(noOrigin.text), noOrigin.off!.recheck]).toEqual(["The repo had no GitHub remote named origin when the item started.", false]);
    const local = pr({ ...finishable, privacy: "local_only" }, setup);
    expect([flat(local.text), flat(local.off!.status), local.button.disabled]).toEqual(["This item is local only: its template lets nothing leave this machine.", "✕ local only", true]);
    // A conflict's Open PR instead is off too when Open PR is.
    expect(offer(finishView(withFinish({ pushTarget: undefined, failed: { action: "merge", reason: "conflict", detail: "x" } }), setup)).rows[0]!.button.disabled).toBe(true);
  });

  it("while an action runs, says so and turns every button off", () => {
    const view = offer(finishView(withFinish({ running: "merge" }), setup));
    expect(view.running).toBe("Merging into main");
    expect(view.rows.every((row) => row.button.disabled === true)).toBe(true);
  });
});

describe("finishView: how the item ended", () => {
  it("Merged · abc1234, with the worktree removed and when", () => {
    const view = ended(finishView(withFinish({ merged: { baseBranch: "main", commit: "abc1234def5678901234567890abcdef12345678" }, worktreeRemoved: true, at: AT }), setup));
    expect([view.mark.symbol, view.mark.word, view.title, flat(view.detail), view.removable]).toEqual(["✓", "merged", "Merged into main · abc1234", "Worktree and branch removed · 14:58", false]);
  });

  it("a merge that kept the worktree says why and offers Remove worktree", () => {
    const view = ended(finishView(withFinish({ merged: { baseBranch: "main", commit: "a".repeat(40) }, detail: "The worktree was kept: it has files that are not in the commit." }), setup));
    expect([flat(view.detail), view.removable]).toEqual(["The worktree was kept: it has files that are not in the commit.", true]);
  });

  it("PR #12 open, with its URL as text; the worktree stays until removed", () => {
    const view = ended(finishView(withFinish({ pullRequest: { url: "https://github.com/northwind/orders-api/pull/12" } }), setup));
    expect([view.mark.symbol, view.title, view.url, flat(view.detail), view.removable]).toEqual([
      "↗",
      "PR #12 open",
      "https://github.com/northwind/orders-api/pull/12",
      "Pushed tokama/0b9f3c1e · the worktree stays until the PR is merged or closed",
      true,
    ]);
  });

  it("Discarded, with when, and the log kept", () => {
    const view = ended(finishView(withFinish({ worktreeRemoved: true, at: AT }), setup));
    expect([view.mark.symbol, view.mark.word, view.title, flat(view.detail), view.removable]).toEqual(["⊘", "discarded", "Discarded", "Worktree and branch deleted · 14:58 · the log is kept", false]);
  });
});

it("finishState, isDiscarded and prName", () => {
  expect(finishState(finishable)).toBeUndefined();
  expect(finishState(withFinish({ merged: { baseBranch: "main", commit: "a".repeat(40) } }))).toBe("merged");
  expect(finishState(withFinish({ pullRequest: { url: "https://github.com/a/b/pull/3" } }))).toBe("PR open");
  expect(isDiscarded(withFinish({ worktreeRemoved: true }))).toBe(true);
  expect(isDiscarded(withFinish({ worktreeRemoved: true, pullRequest: { url: "https://github.com/a/b/pull/3" } }))).toBe(false);
  expect(prName("https://github.com/a/b/pull/128")).toBe("PR #128");
});

it("finishNote: how a finished row ends in the list, with a mark", () => {
  expect(finishNote(finishable)).toBeUndefined();
  expect(finishNote(withFinish({ running: "pull_request" }))).toMatchObject({ text: "Open PR running", mark: { symbol: "●" } });
  expect(finishNote(withFinish({ merged: { baseBranch: "main", commit: "abc1234" + "0".repeat(33) }, worktreeRemoved: true }))).toMatchObject({ text: "Merged into main · abc1234", mark: { symbol: "✓" } });
  expect(finishNote(withFinish({ pullRequest: { url: "https://github.com/a/b/pull/12" } }))).toMatchObject({ text: "PR #12 open", mark: { symbol: "↗" } });
  expect(finishNote(withFinish({ worktreeRemoved: true }))).toMatchObject({ text: "Discarded", mark: { symbol: "⊘" } });
  expect(finishNote(withFinish({ failed: { action: "merge", detail: "x" } }))).toMatchObject({ text: "Merge did not finish", mark: { symbol: "!" } });
});
