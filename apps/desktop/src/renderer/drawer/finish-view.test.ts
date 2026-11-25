import type { ItemRecord, Setup } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { committed, finishable, setup } from "../testing/drawer.js";
import { finishNote, finishView } from "./finish-view.js";

const withFinish = (finish: Partial<NonNullable<ItemRecord["finish"]>>): ItemRecord => ({ ...finishable, finish: { ...finishable.finish!, ...finish } });
const ghLoggedOut = { ...setup, health: { ...setup.health, gh: { installed: true, loggedIn: false, message: "gh is not logged in to github.com." } } } as Setup;

describe("finishView", () => {
  it("offers Merge into the repo's base branch, Open PR with its push target, and Discard", () => {
    expect(finishView(finishable, setup)).toEqual({
      lines: [],
      buttons: [
        { action: "merge", label: "Merge into main" },
        { action: "pull_request", label: "Open PR" },
        { action: "discard", label: "Discard" },
      ],
      pushNote: "Open PR pushes to github.com/northwind/orders-api",
    });
    expect(finishView(committed, setup)).toBeUndefined();
  });

  it("disables Open PR with the reason: gh logged out, or nowhere to push", () => {
    expect(finishView(finishable, ghLoggedOut)?.buttons[1]).toEqual({ action: "pull_request", label: "Open PR", unavailable: "gh is not logged in to github.com." });
    expect(finishView(withFinish({ pushTarget: undefined }), setup)?.buttons[1]?.unavailable).toMatch(/no origin remote/);
  });

  it("shows what was done, the running action, and the last failure, each with a symbol and a word", () => {
    expect(finishView(withFinish({ running: "merge" }), setup)).toMatchObject({ running: "Merging into main", buttons: [] });
    const merged = finishView(withFinish({ merged: { baseBranch: "main", commit: "abcdef1234567890abcdef1234567890abcdef12" }, worktreeRemoved: true }), setup)!;
    expect(merged.lines.map((line) => [line.mark.symbol, line.mark.word, line.text])).toEqual([
      ["✓", "merged", "Merged into main · abcdef1"],
      ["■", "removed", "The worktree and branch are removed."],
    ]);
    expect(merged.buttons).toEqual([]);
    const pr = finishView(withFinish({ pullRequest: { url: "https://github.com/northwind/orders-api/pull/7" } }), setup)!;
    expect(pr.lines[0]?.text).toBe("Pull request opened: https://github.com/northwind/orders-api/pull/7");
    expect(pr.buttons.map((b) => b.action)).toEqual(["discard"]);
    const failed = finishView(withFinish({ failed: { action: "merge", detail: "Your checkout is on feature, not main." } }), setup)!;
    expect(failed.lines).toEqual([{ mark: { symbol: "✕", word: "failed", tone: "fail" }, text: "Merge did not finish: Your checkout is on feature, not main." }]);
  });
});

it("finishNote: a short list line once an action ran", () => {
  expect(finishNote(finishable)).toBeUndefined();
  expect(finishNote(withFinish({ running: "pull_request" }))).toBe("Open PR running");
  expect(finishNote(withFinish({ merged: { baseBranch: "main", commit: "a".repeat(40) }, worktreeRemoved: true }))).toBe("✓ merged into main");
  expect(finishNote(withFinish({ worktreeRemoved: true }))).toBe("■ discarded");
});

it("finishView: Open PR is disabled for a local-only item, and names no push target", () => {
  const local = { ...finishable, privacy: "local_only" } as ItemRecord;
  const view = finishView(local, setup)!;
  expect(view.buttons[1]).toEqual({ action: "pull_request", label: "Open PR", unavailable: "This item is local only: its template lets nothing leave this machine." });
  expect(view.pushNote).toBeUndefined();
});
