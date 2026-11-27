import { describe, expect, it } from "vitest";
import type { Git } from "../../kernel/git/index.js";
import { ok } from "../../kernel/result/index.js";
import { branchRef, createRefLedger, movedRefs, movedRefsText } from "./moved-refs.js";

const refs = (entries: Record<string, string>) => new Map(Object.entries(entries));
const NONE: ReadonlySet<string> = new Set();

describe("movedRefs", () => {
  const before = refs({ "refs/heads/main": "a1", "refs/heads/tokama/0b9f12ab": "a1", "refs/tags/v1": "t1" });

  it("lists a moved branch, a deleted tag and a new branch, sorted", () => {
    const after = refs({ "refs/heads/main": "z9", "refs/heads/tokama/0b9f12ab": "a1", "refs/heads/side": "a1" });
    expect(movedRefs(before, after, NONE)).toEqual(["branch main changed", "branch side was created", "tag v1 was deleted"]);
  });

  it("sees a tag that points elsewhere now, and a branch that became a link", () => {
    expect(movedRefs(before, refs({ ...Object.fromEntries(before), "refs/tags/v1": "t2", "refs/heads/main": "a1 -> refs/heads/x" }), NONE)).toEqual(["branch main changed", "tag v1 changed"]);
  });

  it("leaves out the refs it is told to ignore", () => {
    const after = refs({ "refs/heads/main": "a1", "refs/heads/tokama/0b9f12ab": "b2", "refs/tags/v1": "t1" });
    expect(movedRefs(before, after, new Set(["refs/heads/tokama/0b9f12ab"]))).toEqual([]);
  });
});

describe("movedRefsText", () => {
  it("names one ref or the first five of many", () => {
    expect(movedRefsText(["branch main changed"])).toBe("Branch main changed during this step. Tokama stopped the item; nothing was undone.");
    expect(movedRefsText(["tag v1.2 was deleted"])).toBe("Tag v1.2 was deleted during this step. Tokama stopped the item; nothing was undone.");
    expect(movedRefsText(["branch a changed", "branch b changed", "branch c changed", "branch d changed", "branch e changed", "tag f was deleted", "tag g was deleted"])).toBe(
      "During this step, branch a changed; branch b changed; branch c changed; branch d changed; branch e changed; and 2 more. Tokama stopped the item; nothing was undone.",
    );
  });
});

describe("the ref ledger", () => {
  /** A git whose refs the test sets. */
  const fakeGit = (current: { refs: Map<string, string> }) => ({ refs: async () => ok(new Map(current.refs)) }) as unknown as Git;
  const start = () => ({ refs: refs({ "refs/heads/main": "a1", "refs/heads/tokama/own": "a1", "refs/heads/tokama/other": "a1" }) });

  const writes = (state: { refs: Map<string, string> }, change: (refs: Map<string, string>) => void) => async () => change(state.refs);

  it("ignores the item's own branch, takes what Tokama wrote as the new start, and reports the rest", async () => {
    const state = start();
    const ledger = createRefLedger(fakeGit(state));
    const watch = await ledger.watch("/repo", "tokama/own");
    if (!watch.ok) throw new Error(watch.error);
    state.refs.set("refs/heads/tokama/own", "b2");
    await ledger.around("/repo", [branchRef("tokama/other"), branchRef("tokama/third"), branchRef("main")], writes(state, (refs) => {
      refs.delete("refs/heads/tokama/other");
      refs.set("refs/heads/tokama/third", "c3");
      refs.set("refs/heads/main", "m2");
    }));
    expect(await watch.value.moved()).toEqual({ ok: true, value: [] });
    // Moved by someone else afterwards: reported, though Tokama wrote the ref before.
    state.refs.set("refs/heads/main", "z9");
    expect(await watch.value.moved()).toEqual({ ok: true, value: ["branch main changed"] });
  });

  it("keeps reporting a ref that had moved before Tokama wrote it", async () => {
    const state = start();
    const ledger = createRefLedger(fakeGit(state));
    const watch = await ledger.watch("/repo", "tokama/own");
    if (!watch.ok) throw new Error(watch.error);
    state.refs.set("refs/heads/main", "agent");
    await ledger.around("/repo", [branchRef("main")], writes(state, (refs) => refs.set("refs/heads/main", "merged")));
    expect(await watch.value.moved()).toEqual({ ok: true, value: ["branch main changed"] });
  });

  it("does not take what Tokama wrote in another repo, or after the watch closed", async () => {
    const state = start();
    const ledger = createRefLedger(fakeGit(state));
    const watch = await ledger.watch("/repo", "tokama/own");
    if (!watch.ok) throw new Error(watch.error);
    await ledger.around("/elsewhere", [branchRef("main")], writes(state, (refs) => refs.set("refs/heads/main", "z9")));
    expect(await watch.value.moved()).toEqual({ ok: true, value: ["branch main changed"] });
    watch.value.close();
    await ledger.around("/repo", [branchRef("main")], writes(state, (refs) => refs.set("refs/heads/main", "z9")));
    expect(await watch.value.moved()).toEqual({ ok: true, value: ["branch main changed"] });
  });

  it("lists only when no write of Tokama's is running, so another item's write is not blamed on the step", async () => {
    const state = start();
    const ledger = createRefLedger(fakeGit(state));
    const watch = await ledger.watch("/repo", "tokama/own");
    if (!watch.ok) throw new Error(watch.error);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    // The write has made its ref, and goes on.
    const writing = ledger.around("/repo", [branchRef("tokama/other2")], async () => {
      state.refs.set("refs/heads/tokama/other2", "d4");
      await held;
    });
    // The write is under way (its ref made) when the step looks.
    await new Promise((resolve) => setImmediate(resolve));
    const checking = watch.value.moved();
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await writing;
    expect(await checking).toEqual({ ok: true, value: [] });
  });

  it("runs the writes on one repo one after the other, and returns what each returns", async () => {
    const ledger = createRefLedger(fakeGit(start()));
    const order: string[] = [];
    const slow = ledger.around("/repo", [], async () => (await new Promise((resolve) => setImmediate(resolve)), order.push("first"), 1));
    const quick = ledger.around("/repo", [], async () => (order.push("second"), 2));
    expect([await slow, await quick, order]).toEqual([1, 2, ["first", "second"]]);
  });

  it("passes a failed write to its caller and goes on with the next one", async () => {
    const state = start();
    const ledger = createRefLedger(fakeGit(state));
    const watch = await ledger.watch("/repo", "tokama/own");
    if (!watch.ok) throw new Error(watch.error);
    await expect(ledger.around("/repo", [], async () => Promise.reject(new Error("merge failed")))).rejects.toThrow("merge failed");
    expect(await ledger.around("/repo", [], async () => 3)).toBe(3);
    expect(await watch.value.moved()).toEqual({ ok: true, value: [] });
  });

  it("returns what the write returns", async () => {
    expect(await createRefLedger(fakeGit(start())).around("/repo", [], async () => 7)).toBe(7);
  });

  it("stops when the item's own branch became a link to another branch", async () => {
    const state = start();
    const watch = await createRefLedger(fakeGit(state)).watch("/repo", "tokama/own");
    if (!watch.ok) throw new Error(watch.error);
    state.refs.set("refs/heads/tokama/own", "a1 -> refs/heads/main");
    expect(await watch.value.moved()).toEqual({ ok: true, value: ["branch tokama/own became a link to another branch"] });
  });
});
