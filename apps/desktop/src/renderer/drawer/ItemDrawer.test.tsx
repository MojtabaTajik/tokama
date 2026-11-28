// @vitest-environment happy-dom
import type { Decision, ItemActivity, ItemChange, ItemRecord, ItemUsage, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { App } from "../App.js";
import { BACKEND_IDS, backendOf } from "../brand/backends/index.js";
import { board, itemList, type ListQuery } from "../testing/bridge.js";
import { approved, committed, DECISION_ID, finishable, noChangeAsked, noChangeDone, needsYou, setup, stoppedReview, task } from "../testing/drawer.js";
import { cardOffersStop } from "./DecisionChoices.js";
import { ItemDrawer, tabsOf } from "./ItemDrawer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/**
 * A bridge over a set of items: `setup`, `board`, `item_list` and `item` answer from it, commands answer
 * with `commandReply` (null by default), and events are pushed by hand to every listener.
 */
function fakeBridge(start: ItemRecord[], activities = new Map<string, ItemActivity>(), usages = new Map<string, ItemUsage>()) {
  const store = new Map<string, ItemRecord>(start.map((item) => [item.id, item]));
  const eventListeners = new Set<(event: BridgeEvent) => void>();
  const connectionListeners = new Set<(state: ConnectionState) => void>();
  let commandReply: (command: { type: string }) => Promise<Reply> = async () => ({ ok: true, data: null });
  const query = vi.fn(async (q: { type: string; itemId?: string }): Promise<Reply> => {
    if (q.type === "setup") return { ok: true, data: setup };
    if (q.type === "board") return { ok: true, data: board([...store.values()]) };
    if (q.type === "item_list") return { ok: true, data: itemList([...store.values()], q as unknown as ListQuery) };
    const item = q.itemId === undefined ? undefined : store.get(q.itemId);
    if (q.type === "item" && item) return { ok: true, data: { item, ...(usages.has(item.id) && { usage: usages.get(item.id) }) } };
    if (q.type === "item_diff") return { ok: true, data: { kind: "none" } };
    if (q.type === "activity" && item) return { ok: true, data: { activity: activities.get(item.id) ?? null } };
    return { ok: false, error: { code: "not_found", message: `no item ${String(q.itemId)}` } };
  });
  const command = vi.fn((c: { type: string }) => commandReply(c));
  const bridge = {
    getConnection: vi.fn(async (): Promise<ConnectionState> => ({ status: "connected", engineId: "e-1" })),
    getUpdate: vi.fn(async () => ({ status: "idle" as const })),
    onUpdate: vi.fn(() => () => undefined),
    openUpdateNotes: vi.fn(async () => undefined),
    getAway: vi.fn(async () => ({ seenUntil: 0, due: false })),
    onAway: vi.fn(() => () => undefined),
    onConnection: vi.fn((listener: (state: ConnectionState) => void) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    }),
    query,
    command,
    getToolsPath: vi.fn(async () => ({ source: "inherited" as const })),
    saveLayout: vi.fn(async () => undefined),
    setViewedItem: vi.fn(async () => undefined),
    onOpenItem: vi.fn(() => () => undefined),
    onOpenGetStarted: vi.fn(() => () => undefined),
    onEvent: vi.fn((listener: (event: BridgeEvent) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
  } as unknown as TokamaBridge;
  let seq = 0;
  /** The engine changes the item: the store and every listener hear it. */
  const push = (item: ItemRecord) =>
    act(async () => {
      store.set(item.id, item);
      for (const listener of eventListeners) listener({ kind: "event", seq: seq++, event: { type: "item_updated", item } });
    });
  const set = (item: ItemRecord) => store.set(item.id, item);
  const replyWith = (reply: (command: { type: string }) => Promise<Reply>) => (commandReply = reply);
  const setConnection = (state: ConnectionState) =>
    act(async () => {
      for (const listener of connectionListeners) listener(state);
    });
  const reconnect = () => setConnection({ status: "connected", engineId: "e-2" });
  return { bridge, query, command, push, set, replyWith, reconnect, setConnection, listeners: eventListeners };
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderDrawer = async (bridge: TokamaBridge, itemId: string, onClose = vi.fn(), setupData: Setup | undefined = setup) => {
  await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={itemId} setup={setupData} onClose={onClose} />));
  return onClose;
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const button = (label: string) => $$("button").find((el) => el.textContent === label || el.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
const click = (el: Element | undefined) => act(async () => (el as HTMLElement).click());
const showTab = (name: string) => click($$('[role="tab"]').find((el) => el.textContent === name));
const key =(name: string) => act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
const deferred = () => {
  let resolve!: (reply: Reply) => void;
  const promise = new Promise<Reply>((done) => (resolve = done));
  return { promise, resolve };
};

describe("ItemDrawer sections", () => {
  it("shows the kind, template, privacy, title and state with its symbol and word", async () => {
    await renderDrawer(fakeBridge([needsYou]).bridge, needsYou.id);
    expect(text(".drawer-kind")).toBe("◎ Investigation · Emergency investigator · local + cloud");
    expect(text(".drawer h2")).toBe("Orders API returns 500 after deploy");
    expect(text(".drawer-state")).toBe("⏸needs you · step 4 of 4 · Propose a fix");
    // "step 4 of 4" wraps as one piece.
    expect(text(".drawer-position .nowrap")).toBe("step 4 of 4");
    expect($(".drawer-state .mark")?.getAttribute("aria-hidden")).toBe("true");
    expect($(".drawer")?.getAttribute("aria-labelledby")).toBe($(".drawer h2")?.id);
  });

  it("shows the needs-you note: question, why, the exact summary and a button per choice", async () => {
    await renderDrawer(fakeBridge([needsYou]).bridge, needsYou.id);
    expect(text(".needs-you-question")).toBe("⏸Send the redacted findings summary to Architect on Claude Code?");
    expect(text(".needs-you-why")).toBe("Propose a fix runs on a cloud agent; its data rule sends a summary after your approval.");
    expect(text(".cloud-summary-label")).toBe("Will be sentNothing has been sent yet");
    expect(text(".cloud-summary-text")).toBe(needsYou.decision?.summaryText);
    expect($$(".needs-you .choices .btn").map((el) => [el.textContent, el.className])).toEqual([
      ["Approve and send", "btn btn-primary"],
      ["Stop", "btn btn-secondary"],
    ]);
  });

  it("shows each step with its state as a word, its agent name in colour, where it runs and its detail; no dot", async () => {
    await renderDrawer(fakeBridge([needsYou]).bridge, needsYou.id);
    const steps = $$(".step").map((li) => ({
      name: li.querySelector(".step-name")?.textContent,
      colour: li.querySelector(".step-where .agent-name")?.getAttribute("data-agent"),
      where: li.querySelector(".step-where")?.textContent,
      detail: li.querySelector(".step-detail")?.textContent,
    }));
    expect(steps).toEqual([
      { name: "Triage ✓ passed", colour: "2", where: "Local investigator · qwen3-coder:30b · local", detail: "scope: orders-api, last 2 h" },
      {
        name: "Query logs and metrics ✓ passed",
        colour: "2",
        where: "Local investigator · qwen3-coder:30b · local · App Insights (query), Postgres (read-only)",
        detail: "6 queries · 41 rows",
      },
      { name: "Find the cause ✓ passed", colour: "2", where: "Local investigator · qwen3-coder:30b · local", detail: undefined },
      {
        name: "Propose a fix ⏸ needs you",
        colour: "1",
        where: "Architect · opus · cloud · sees your approved summary only",
        detail: "waits for your approval of the cloud step",
      },
    ]);
    expect($(".agent-dot")).toBeNull();
  });

  it("says a step that runs or has not started in a word with no symbol: running, next", async () => {
    const live = { ...task, state: "running", steps: task.steps.map((step, index) => ({ ...step, state: index === 0 ? "running" : "pending" })) } as ItemRecord;
    await renderDrawer(fakeBridge([live]).bridge, live.id);
    const words = $$(".step").map((li) => li.querySelector(".step-name .mark-word")?.textContent);
    expect(words[0]).toBe("running");
    expect(words.slice(1).every((word) => word === "next")).toBe(true);
    expect($$(".step .step-name .mark")).toHaveLength(0);
  });

  it("has Steps, Output and Log for an investigation: it changes no repo, so Checks and Diff are hidden, and Evidence and Findings too", async () => {
    await renderDrawer(fakeBridge([needsYou]).bridge, needsYou.id);
    expect($$('[role="tab"]').map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["Steps", "true"],
      ["Output", "false"],
      ["Log", "false"],
    ]);
    expect($(".step")).not.toBeNull();
    expect(text('[role="tabpanel"]')).not.toContain("comes later");
  });

  it("shows a task with Steps, Output, Checks and Log, and no Diff while no decision carries one", async () => {
    await renderDrawer(fakeBridge([task]).bridge, task.id);
    expect($$('[role="tab"]').map((tab) => tab.textContent)).toEqual(["Steps", "Output", "Checks", "Log"]);
    expect(text(".drawer-kind")).toBe("▣ Task · Plan and build · local + cloud");
    expect($(".needs-you")).toBeNull();
    expect($$(".step-where").map((el) => el.textContent)).toEqual([
      "Architect · opus · cloud · sees the repo and the diff",
      "Local builder · qwen3-coder:30b · local",
      "Tokama · local",
      "Reviewer · gpt-5-codex · cloud · sees the repo and the diff",
    ]);
    expect($$(".drawer-actions button").map((el) => [el.textContent, el.className, el.getAttribute("aria-disabled")])).toEqual([["Stop", "btn btn-danger", null]]);
  });

  it("shows only the actions that work: Stop while the item runs, no actions once it has ended", async () => {
    const { bridge, push } = fakeBridge([task]);
    await renderDrawer(bridge, task.id);
    expect($$(".drawer-actions button").map((el) => el.textContent)).toEqual(["Stop"]);
    expect(document.body.textContent).not.toMatch(/Open worktree|Add a hint/);
    await push({ ...task, state: "done" } as ItemRecord);
    expect($(".drawer-actions")).toBeNull();
    expect(text(".drawer-state")).toBe("✓done");
  });

  it("hides the row's Stop while the card offers its own, and shows it again once that card is gone", async () => {
    const { bridge, push } = fakeBridge([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    expect($(".drawer-actions")).toBeNull();
    expect($$(".drawer button").filter((el) => el.textContent === "Stop")).toHaveLength(1);
    await push({ ...needsYou, state: "running", decision: undefined } as ItemRecord);
    expect($$(".drawer-actions button").map((el) => el.textContent)).toEqual(["Stop"]);
  });

  it("says when the item does not exist", async () => {
    await renderDrawer(fakeBridge([]).bridge, needsYou.id);
    expect(text(".drawer-header")).toContain("This item no longer exists.");
    expect($('[role="tab"]')).toBeNull();
  });

  it("says when a needs-you item has no question", async () => {
    const waiting = { ...approved, state: "needs_you" } as ItemRecord;
    await renderDrawer(fakeBridge([waiting]).bridge, waiting.id);
    expect(text(".needs-you")).toBe("⏸This item waits for you, but the engine sent no question yet.");
    expect($(".needs-you button")).toBeNull();
  });
});

describe("ItemDrawer engine text", () => {
  it("renders an HTML-looking cloud summary and title as text, never as markup", async () => {
    const html = '<img src=x onerror="alert(1)"><b>bold</b><script>alert(2)</script>';
    const decision = { ...needsYou.decision!, summaryText: html, question: "<i>Send?</i>" };
    const item = { ...needsYou, title: "<em>title</em>", decision } as ItemRecord;
    await renderDrawer(fakeBridge([item]).bridge, item.id);
    expect(text(".cloud-summary-text")).toBe(html);
    expect($(".cloud-summary-text")?.children.length).toBe(0);
    expect(text(".drawer h2")).toBe("<em>title</em>");
    expect(text(".needs-you-question")).toContain("<i>Send?</i>");
    expect($$(".drawer img:not(.backend-mark), .drawer b, .drawer script, .drawer em, .drawer i")).toEqual([]);
    for (const mark of $$(".drawer img.backend-mark")) expect(BACKEND_IDS.map((id) => backendOf(id).iconUrl)).toContain(mark.getAttribute("src"));
  });
});

describe("ItemDrawer change to approve", () => {
  const DIFF_DECISION = "decision_00000000-0000-4000-8000-0000000000d1";
  const waiting = {
    ...task,
    templateId: "builtin/quick-change",
    state: "needs_you",
    decision: {
      id: DIFF_DECISION,
      kind: "plan_approval",
      stepIndex: 0,
      question: "Commit this change?",
      why: "Local builder changed 4 files in a worktree of orders-api. Nothing is committed until you approve.",
      hasDiff: true,
      choices: [
        { id: "approve", label: "Approve and commit" },
        { id: "request_changes", label: "Request changes" },
        { id: "no_action_needed", label: "End: no action needed" },
        { id: "stop", label: "Stop" },
      ],
    },
    steps: [{ name: "Change", stage: "review", state: "needs_you", agentId: "local-builder", data: "none", runs: 1, maxAttempts: 3, attempts: [{ attempt: 1, result: "passed", checks: [] }] }],
  } as unknown as ItemRecord;
  const file = (path: string, extra: Record<string, unknown> = {}) => ({ path, status: "modified", added: 1, removed: 1, binary: false, cut: false, hunks: [], ...extra });
  const diff = {
    files: [
      file("src/a.ts", { hunks: [{ header: "@@ -4,2 +4,2 @@ function total() {", lines: [" keep", '-<img src=x onerror="alert(1)">', "+<b>bold</b>", "\\ No newline at end of file"] }] }),
      file("src/new.ts", { oldPath: "src/old.ts", status: "renamed", added: 0, removed: 0 }),
      file("logo.png", { status: "added", added: null, removed: null, binary: true, cut: true }),
      file("package-lock.json", { added: 1220, removed: 313, cut: true }),
    ],
    moreFiles: 2,
    cut: true,
    worktree: { repoId: "orders-api", dir: ".tokama/wt/abc", branch: "tokama/abc", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" },
  };
  const withDiff = (reply: Reply, items: ItemRecord[] = [waiting]) => {
    const fake = fakeBridge(items);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => (q.type === "decision_diff" ? reply : base(q)));
    return fake;
  };
  const tab = (name: string) => $$('[role="tab"]').find((el) => el.textContent === name);
  const pick = (path: string) => click($$(".dv-file").find((el) => el.querySelector(".dv-path")?.textContent?.startsWith(path)));
  const rows = () => $$(".dv-row").map((row) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent).join("|"));

  it("opens on the Diff tab; the decision shows its question, why, and only Approve and commit and Request changes", async () => {
    const { bridge, query } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    expect(tab("Diff")?.getAttribute("aria-selected")).toBe("true");
    expect(query).toHaveBeenCalledWith({ type: "decision_diff", itemId: waiting.id, decisionId: DIFF_DECISION });
    expect($(".needs-you-kind")).toBeNull();
    expect(text(".needs-you-question")).toBe("⏸Commit this change?");
    expect($$(".needs-you .choices .btn").map((el) => el.textContent)).toEqual(["Approve and commit", "Request changes"]);
    expect(text(".dv-summary")).toBe("6 files+1,221 −314·tokama/abcfrom main 85a75e3");
  });

  it("keeps the row's Stop, because the change approval's card does not show one", async () => {
    const { bridge } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    expect($$(".needs-you .choices .btn").map((el) => el.textContent)).toEqual(["Approve and commit", "Request changes"]);
    expect($$(".drawer-actions button").map((el) => el.textContent)).toEqual(["Stop"]);
  });

  it("lists the files with status, counts or why they are not drawn, and shows the first file with line numbers, as text", async () => {
    const { bridge } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    expect($$(".dv-file").map((el) => el.textContent)).toEqual([
      "Mmodifiedsrc/a.ts+1−1",
      "Rrenamedsrc/old.ts → src/new.ts+0−0",
      "Aaddedlogo.pngbinary",
      "Mmodifiedpackage-lock.jsontoo large",
    ]);
    expect(text(".dv-more")).toBe("2 more files not listed");
    expect($$(".dv-file").map((el) => el.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(text(".dv-panel-head")).toBe("src/a.tsmodified · +1 −1");
    expect($(".dv-open")).toBeNull();
    expect(rows()).toEqual(["|||@@ -4,2 +4,2 @@ function total() {", "4|4||keep", "5||−|<img src=x onerror=\"alert(1)\">", "|5|+|<b>bold</b>", "|||\\ No newline at end of file"]);
    expect($$(".dv-row [aria-label]").map((el) => el.getAttribute("aria-label"))).toEqual(["unchanged", "removed", "added"]);
    expect($$(".drawer img, .drawer b")).toEqual([]);
  });

  it("says why a binary or too-large file is not drawn, and where to find it", async () => {
    const { bridge } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    await pick("logo.png");
    expect(text(".dv-note")).toBe("Binary file, not shown here.Open it in your editor or an image viewer to compare.In repo orders-api: .tokama/wt/abc/logo.png");
    await pick("package-lock.json");
    expect(text(".dv-note-head")).toBe("Too large to show here.");
    expect($$(".dv-note-text")[0]?.textContent).toBe("1,533 changed lines; the drawer shows files up to 1,000 changed lines. Open it in your editor to review.");
  });

  it("shows a path with a line break quoted, so its lines never sit under a made-up file name", async () => {
    const tricky = { ...diff, cut: false, moreFiles: 0, files: [{ ...diff.files[0]!, path: "notes\n── src/auth.ts" }] };
    const { bridge } = withDiff({ ok: true, data: tricky });
    await renderDrawer(bridge, waiting.id);
    expect(text(".dv-file .dv-path")).toBe('"notes\\n── src/auth.ts"');
    expect(text(".dv-panel-path")).toBe('"notes\\n── src/auth.ts"');
  });

  it("shows characters that reorder text as visible escapes, in paths and lines", async () => {
    const line = "+x = 1; /* \u202e } \u2066 if (admin) \u2069 */";
    const tricky = { ...diff, cut: false, moreFiles: 0, files: [{ ...diff.files[0]!, path: "a\u202esj.txt", hunks: [{ header: "@@ -1 +1 @@", lines: [line, "+a\u2028b\u200f\u061c"] }] }] };
    const { bridge } = withDiff({ ok: true, data: tricky });
    await renderDrawer(bridge, waiting.id);
    expect(text(".dv-file .dv-path")).toBe("a<U+202E>sj.txt");
    expect(rows().slice(1)).toEqual(["|1|+|x = 1; /* <U+202E> } <U+2066> if (admin) <U+2069> */", "|2|+|a<U+2028>b<U+200F><U+061C>"]);
    expect(text(".drawer")).not.toMatch(/\p{Bidi_Control}|[\u2028\u2029]/u);
  });

  it("says when the change cannot be loaded", async () => {
    const { bridge } = withDiff({ ok: false, error: { code: "stale_decision", message: "Decision is not open." } });
    await renderDrawer(bridge, waiting.id);
    expect(text(".drawer-panel .inline-error")).toBe("✕Could not load the change: Decision is not open.");
  });

  it("Request changes opens a note for the agent's next run in place of the buttons; Cancel brings them back", async () => {
    const { bridge, command } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    await click(button("Request changes"));
    expect(command).not.toHaveBeenCalled();
    expect($$(".needs-you .choices .btn").map((el) => el.textContent)).toEqual(["Send to Local builder", "Cancel"]);
    expect(text(".decision-note-hint")).toBe("Goes into Local builder's next run with the current diff. Run 2 of 3.");
    await click(button("Cancel"));
    await click(button("Request changes"));
    const note = $(".decision-note-text") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "  Keep the old name.  ");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Send to Local builder"));
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: waiting.id, decisionId: DIFF_DECISION, choice: "request_changes", note: "Keep the old name." });
  });

  it("at the step's limit, the note says Tokama asks before it runs again", async () => {
    const atLimit = { ...waiting, steps: [{ ...waiting.steps[0]!, runs: 3 }] } as unknown as ItemRecord;
    const { bridge } = withDiff({ ok: true, data: diff }, [atLimit]);
    await renderDrawer(bridge, atLimit.id);
    await click(button("Request changes"));
    expect(text(".decision-note-hint")).toBe("Goes into Local builder's next run with the current diff. The step has used its 3 runs, so Tokama asks you before it runs again.");
  });

  it("opens on Diff for each new change approval, goes back to Steps once it is answered, and on Review the diff", async () => {
    const running = { ...waiting, state: "running", decision: undefined } as unknown as ItemRecord;
    const { bridge, push } = withDiff({ ok: true, data: diff }, [running]);
    await renderDrawer(bridge, running.id);
    expect(tab("Steps")?.getAttribute("aria-selected")).toBe("true");
    // The question arrives while the drawer shows the item.
    await push(waiting);
    expect(tab("Diff")?.getAttribute("aria-selected")).toBe("true");
    await click(tab("Steps"));
    // Review the diff asks again for an item the drawer already shows.
    await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={waiting.id} setup={setup} onClose={vi.fn()} diffAsked={1} />));
    expect(tab("Diff")?.getAttribute("aria-selected")).toBe("true");
    // Answered: the Diff tab has nothing to show, so the drawer goes back to Steps.
    await push(running);
    expect(tab("Steps")?.getAttribute("aria-selected")).toBe("true");
  });

  it("after the decision: the step running again with your note, then the result card in place of a commit note", async () => {
    const again = { ...waiting, state: "running", decision: undefined, steps: [{ ...waiting.steps[0]!, state: "running", changesNote: "Keep the old name.", runs: 2, attempts: [{ attempt: 1, result: "passed", checks: [] }, { attempt: 2, checks: [] }] }] } as unknown as ItemRecord;
    const { bridge, push } = withDiff({ ok: true, data: diff }, [again]);
    await renderDrawer(bridge, again.id);
    expect(text(".after")).toBe("●Local builder is making your changes · run 2 of 3Your note: \"Keep the old name.\"");
    await push({ ...again, state: "done", steps: [{ ...again.steps[0]!, state: "passed" }], outcome: { kind: "done", commits: [{ repoId: "orders-api", commit: "3f9c2e1d4e5f60718293a4b5c6d7e8f901234567", branch: "tokama/abc" }] } } as unknown as ItemRecord);
    // The note that said "Committed" is gone: the card says what the work produced, the commit is in the state line.
    expect($(".after")).toBeNull();
    expect($(".result-card")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Committed");
    expect(text(".drawer-state")).toContain("commit 3f9c2e1 on tokama/abc");
  });

  it("after a merge shows the card and the Merged card: the branch is gone, what the work produced is not", async () => {
    const commit = { repoId: "orders-api", commit: "3f9c2e1d4e5f60718293a4b5c6d7e8f901234567", branch: "tokama/abc" };
    const done = { ...task, state: "done", outcome: { kind: "done", commits: [commit] }, finish: undefined } as unknown as ItemRecord;
    const { bridge, push } = fakeBridge([done]);
    await renderDrawer(bridge, done.id);
    expect($$(".result-card")).toHaveLength(1);
    await push({ ...done, finish: { worktreeRemoved: true, at: Date.UTC(2026, 10, 25, 14, 58), merged: { baseBranch: "main", commit: commit.commit } } } as unknown as ItemRecord);
    expect($(".after")).toBeNull();
    expect($$(".result-card")).toHaveLength(1);
    expect($$(".finish-ended")).toHaveLength(1);
    expect(text(".finish-ended-body")).toMatch(/^merged: Merged into main · 3f9c2e1 · \d\d:\d\dWorktree and branch removed$/);
  });
});

describe("ItemDrawer step output", () => {
  const PLAN_DECISION = "decision_00000000-0000-4000-8000-0000000000e1";
  const PLAN = "## Plan\n\n- Add a `stock_reservations` table\n- Call it at checkout\n\n<script>alert(1)</script>";
  const planStep = { name: "Plan", stage: "working", state: "needs_you", agentId: "architect", data: "none", runs: 1, maxAttempts: 3, attempts: [{ attempt: 1, result: "passed", checks: [] }] };
  const waiting = {
    ...task,
    state: "needs_you",
    decision: {
      id: PLAN_DECISION,
      kind: "plan_approval",
      stepIndex: 0,
      question: "Approve this step's result?",
      why: "Architect wrote a plan and changed 0 files.",
      choices: [
        { id: "approve", label: "Approve" },
        { id: "request_changes", label: "Request changes" },
        { id: "stop", label: "Stop" },
      ],
    },
    steps: [planStep, { name: "Build", stage: "working", state: "pending", agentId: "local-builder", data: "none" }],
  } as unknown as ItemRecord;
  const withOutput = (output: (q: { attempt?: number }) => Reply | Promise<Reply>, items: ItemRecord[] = [waiting]) => {
    const fake = fakeBridge(items);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string; attempt?: number }) => (q.type === "step_output" ? output(q) : base(q)));
    return fake;
  };
  const outputCalls = (query: ReturnType<typeof vi.fn>) => query.mock.calls.filter(([q]) => (q as { type: string }).type === "step_output").map(([q]) => q as unknown);

  it("opens the waiting step in the Output tab for each new question, also after the engineer closed it", async () => {
    const fake = withOutput(() => ({ ok: true, data: { attempt: 1, text: PLAN, truncated: false } }));
    await renderDrawer(fake.bridge, waiting.id);
    await showTab("Output");
    const line = () => $(".ot .sec-head");
    expect(line()?.getAttribute("aria-expanded")).toBe("true");
    await click(line() ?? undefined);
    expect(line()?.getAttribute("aria-expanded")).toBe("false");
    // Leaving and coming back does not open it again: it is the same question.
    await showTab("Steps");
    await showTab("Output");
    expect(line()?.getAttribute("aria-expanded")).toBe("false");
    await fake.push({ ...waiting, decision: { ...waiting.decision!, id: "decision_00000000-0000-4000-8000-0000000000e2" } } as ItemRecord);
    expect(line()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the plan as text above Approve and Request changes, in a preview region", async () => {
    const { bridge, query } = withOutput(() => ({ ok: true, data: { attempt: 1, text: PLAN, truncated: false } }));
    await renderDrawer(bridge, waiting.id);
    expect(outputCalls(query)).toEqual([{ type: "step_output", itemId: waiting.id, stepIndex: 0 }]);
    expect(text(".step-output-label")).toBe("Plan · what Architect wroteattempt 1");
    const box = $(".needs-you .step-output-preview") as HTMLElement;
    expect(box.getAttribute("role")).toBe("region");
    expect(box.getAttribute("aria-label")).toBe("Plan · what Architect wrote");
    expect($$(".needs-you .st-heading").map((el) => el.textContent)).toEqual(["Plan"]);
    expect($$(".needs-you li").map((el) => el.textContent)).toEqual(["Add a stock_reservations table", "Call it at checkout"]);
    expect(box.textContent).toContain("<script>alert(1)</script>");
    expect($$(".drawer script")).toEqual([]);
    // Summary first, then the plan, then the buttons.
    const order = $$(".needs-you-why, .needs-you .step-output, .needs-you .choices .btn");
    expect(order.map((el) => el.className.split(" ")[0])).toEqual(["needs-you-why", "step-output", "btn", "btn", "btn"]);
    expect($(".step-output-cut")).toBeNull();
  });

  it("says when the output was cut, when the attempt saved none, and when the agent wrote nothing", async () => {
    let reply: Reply = { ok: true, data: { attempt: 2, text: "x".repeat(10), truncated: true } };
    const { bridge } = withOutput(() => reply);
    await renderDrawer(bridge, waiting.id);
    expect(text(".step-output-cut")).toBe("!Showing the first 64 KiB. The rest is in the item's folder on this machine.");

    reply = { ok: false, error: { code: "not_found", message: "Attempt 1 has no saved output." } };
    await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={waiting.id} setup={setup} onClose={vi.fn()} key="again" />));
    expect(text(".needs-you .step-output-none")).toBe("This attempt has no saved output.");

    reply = { ok: true, data: { attempt: 1, text: "  \n", truncated: false } };
    await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={waiting.id} setup={setup} onClose={vi.fn()} key="empty" />));
    expect(text(".needs-you .step-output-none")).toBe("The agent wrote no final message.");
  });

  it("never shows an older attempt's text for a newer question", async () => {
    let answer!: (reply: Reply) => void;
    const fake = withOutput(() => new Promise<Reply>((resolve) => (answer = resolve)));
    await renderDrawer(fake.bridge, waiting.id);
    const first = answer;
    const again = { ...waiting, decision: { ...waiting.decision!, id: "decision_00000000-0000-4000-8000-0000000000e2" } } as ItemRecord;
    await fake.push(again);
    await act(async () => first({ ok: true, data: { attempt: 1, text: "the old plan", truncated: false } }));
    expect(container.textContent).not.toContain("the old plan");
    expect(text(".needs-you .placeholder")).toBe("Loading the step's output");
    await act(async () => answer({ ok: true, data: { attempt: 2, text: "the new plan", truncated: false } }));
    expect(text(".needs-you .step-output-preview")).toBe("the new plan");
  });

  it("with a change to approve, shows the output and a way to the Diff tab", async () => {
    const changed = { ...waiting, decision: { ...waiting.decision!, hasDiff: true } } as ItemRecord;
    const fake = withOutput(() => ({ ok: true, data: { attempt: 1, text: "Changed 2 files.", truncated: false } }), [changed]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => (q.type === "decision_diff" ? { ok: true, data: { files: [{ path: "src/a.ts", status: "modified", added: 1, removed: 0, binary: false, cut: false, hunks: [] }], moreFiles: 0, cut: false, worktree: { repoId: "orders-api", dir: ".tokama/wt/abc", branch: "tokama/abc", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" } } } : base(q)));
    await renderDrawer(fake.bridge, changed.id);
    expect(text(".needs-you .step-output-preview")).toBe("Changed 2 files.");
    await click($$('[role="tab"]').find((el) => el.textContent === "Steps"));
    await click(button("See the changed files in the Diff tab"));
    const diffTab = $$('[role="tab"]').find((el) => el.textContent === "Diff");
    expect(diffTab?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(diffTab);
  });

  it("with a change to approve that changed 0 files, has no link to the Diff tab and no Diff tab", async () => {
    const changed = { ...waiting, decision: { ...waiting.decision!, hasDiff: true } } as ItemRecord;
    const fake = withOutput(() => ({ ok: true, data: { attempt: 1, text: "Planned only.", truncated: false } }), [changed]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => (q.type === "decision_diff" ? { ok: true, data: { files: [], moreFiles: 0, cut: false, worktree: { repoId: "orders-api", dir: ".tokama/wt/abc", branch: "tokama/abc", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" } } } : base(q)));
    await renderDrawer(fake.bridge, changed.id);
    expect(text(".needs-you .step-output-preview")).toBe("Planned only.");
    expect(button("See the changed files in the Diff tab")).toBeUndefined();
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual(["Steps", "Output", "Checks", "Log"]);
  });

  describe("the preview", () => {
    const LONG = Array.from({ length: 30 }, (_, line) => `Line ${String(line + 1)}`).join("\n\n");
    const heights = (scroll: number, client: number) => {
      const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scroll);
      const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(client);
      return () => {
        scrollHeight.mockRestore();
        clientHeight.mockRestore();
      };
    };

    const renderWithRead = async (bridge: TokamaBridge, itemId: string, onRead = vi.fn()) => {
      await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={itemId} setup={setup} onClose={vi.fn()} onRead={onRead} />));
      return onRead;
    };

    it("cuts a long plan with Show full plan, which asks for the reader on that step and leaves the tab alone", async () => {
      const restore = heights(600, 171);
      try {
        const { bridge } = withOutput(() => ({ ok: true, data: { attempt: 1, text: LONG, truncated: false } }));
        const onRead = await renderWithRead(bridge, waiting.id);
        expect($(".needs-you .step-output-preview")?.getAttribute("data-cut")).toBe("true");
        await click(button("Show full plan"));
        expect(onRead).toHaveBeenCalledExactlyOnceWith(waiting.decision!.stepIndex);
        expect($$('[role="tab"]').find((el) => el.getAttribute("aria-selected") === "true")?.textContent).toBe("Steps");
      } finally {
        restore();
      }
    });

    it("has no Show full plan link when it cannot open the reader", async () => {
      const restore = heights(600, 171);
      try {
        const { bridge } = withOutput(() => ({ ok: true, data: { attempt: 1, text: LONG, truncated: false } }));
        await renderDrawer(bridge, waiting.id);
        expect($(".needs-you .step-output-preview")?.getAttribute("data-cut")).toBe("true");
        expect(button("Show full plan")).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("says Show full output, not plan, on an approval of a step that is not Plan", async () => {
      const restore = heights(600, 171);
      try {
        const build = { ...waiting, steps: [{ ...planStep, name: "Build" }, waiting.steps[1]!] } as unknown as ItemRecord;
        const { bridge } = withOutput(() => ({ ok: true, data: { attempt: 1, text: LONG, truncated: false } }), [build]);
        const onRead = await renderWithRead(bridge, build.id);
        expect(button("Show full plan")).toBeUndefined();
        await click(button("Show full output"));
        expect(onRead).toHaveBeenCalledExactlyOnceWith(build.decision!.stepIndex);
      } finally {
        restore();
      }
    });

    it("shows a plan that fits whole, with no link", async () => {
      const restore = heights(120, 120);
      try {
        const { bridge } = withOutput(() => ({ ok: true, data: { attempt: 1, text: "Only one line.", truncated: false } }));
        await renderDrawer(bridge, waiting.id);
        expect(text(".needs-you .step-output-preview")).toBe("Only one line.");
        expect($(".needs-you .step-output-preview")?.hasAttribute("data-cut")).toBe(false);
        expect(button("Show full plan")).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("has no expand button on the card or in the Output tab, only the one in the header", async () => {
      const { bridge } = withOutput(() => ({ ok: true, data: { attempt: 1, text: PLAN, truncated: false } }));
      const onExpand = vi.fn();
      await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={waiting.id} setup={setup} onClose={vi.fn()} onExpand={onExpand} />));
      expect($$(".needs-you .expand-button")).toEqual([]);
      await click($$('[role="tab"]').find((el) => el.textContent === "Output"));
      expect($$(".ot .expand-button")).toEqual([]);
      expect(button("Copy")).toBeDefined();
      expect($$('button[aria-label="Open full view"]')).toHaveLength(1);
      await click(button("Open full view"));
      expect(onExpand).toHaveBeenCalledTimes(1);
    });
  });

  it("on the Steps tab, each ended attempt of an agent's step has its output collapsed, asked for when opened", async () => {
    const ran = {
      ...task,
      steps: [
        { ...planStep, state: "passed", attempts: [{ attempt: 1, result: "failed", checks: [] }, { attempt: 2, result: "passed", checks: [] }, { attempt: 3, checks: [] }] },
        { name: "Run checks", stage: "verifying", state: "passed", data: "none", attempts: [{ attempt: 1, result: "passed", checks: [] }] },
      ],
    } as unknown as ItemRecord;
    const { bridge, query } = withOutput((q) => ({ ok: true, data: { attempt: q.attempt, text: `plan ${String(q.attempt)}`, truncated: false } }), [ran]);
    await renderDrawer(bridge, ran.id);
    const lines = $$(".attempt-output > .sec-h > button");
    expect(lines.map((el) => el.textContent)).toEqual(["Output, Plan, attempt 1: Output", "Output, Plan, attempt 2: Output"]);
    expect(lines.map((el) => el.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(outputCalls(query)).toEqual([]);
    await click(lines[1]);
    expect(outputCalls(query)).toEqual([{ type: "step_output", itemId: ran.id, stepIndex: 0, attempt: 2 }]);
    expect($$(".attempt-output")[1]!.querySelector(".step-output-text")?.textContent).toBe("plan 2");
    expect($$(".attempt-output")[0]!.querySelector(".step-output-text")).toBeNull();
  });
});

describe("ItemDrawer decisions", () => {
  it("sends resolve_decision for the chosen button and shows the item the engine sends back", async () => {
    const { bridge, command, push, replyWith } = fakeBridge([needsYou]);
    const pending = deferred();
    replyWith(() => pending.promise);
    await renderDrawer(bridge, needsYou.id);
    await click(button("Approve and send"));
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: needsYou.id, decisionId: DECISION_ID, choice: "approve" });
    // While it is in flight, no second answer can be sent.
    expect($$(".needs-you .choices .btn").every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => pending.resolve({ ok: true, data: null }));
    await push(approved);
    expect($(".needs-you")).toBeNull();
    // A running item shows who works and what in place of the state line.
    expect(text(".activity")).toBe("Architect·working");
    expect($$(".step")[3]?.querySelector(".step-detail")?.textContent).toBe("approved · runs on Architect (opus)");
    expect($('[role="status"]')).toBeNull();
  });

  it("on stale_decision, queries the item again and says that the question changed", async () => {
    const { bridge, query, set, replyWith } = fakeBridge([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    // The engine has moved on to a newer question the drawer has not heard about.
    const newer = { ...needsYou, decision: { ...needsYou.decision!, id: "decision_00000000-0000-4000-8000-000000000001", question: "Send the new summary?" } } as ItemRecord;
    set(newer);
    replyWith(async () => ({ ok: false, error: { code: "stale_decision", message: "decision is not open" } }));
    const before = query.mock.calls.filter(([q]) => q.type === "item").length;
    await click(button("Approve and send"));
    expect(query.mock.calls.filter(([q]) => q.type === "item").length).toBe(before + 1);
    expect(text('[role="status"]')).toBe("!The question changed before your answer reached the engine. The drawer shows the item as it is now.");
    expect(text(".needs-you-question")).toBe("⏸Send the new summary?");
    expect($$(".needs-you .choices .btn").every((el) => !(el as HTMLButtonElement).disabled)).toBe(true);
  });

  it.each([
    ["invalid_choice", "not a choice", "✕The engine did not accept that choice: not a choice"],
    ["not_connected", "no engine", "✕Not connected to the engine. Try again when it is back."],
    ["internal", "boom", "✕Could not send it: boom"],
  ])("says what went wrong on %s", async (code, message, shown) => {
    const { bridge, replyWith } = fakeBridge([needsYou]);
    replyWith(async () => ({ ok: false, error: { code, message } }));
    await renderDrawer(bridge, needsYou.id);
    await click(button("Approve and send"));
    expect(text('[role="status"]')).toBe(shown);
    expect($(".needs-you")).not.toBeNull();
  });

  it("says what went wrong when the bridge itself throws", async () => {
    const { bridge, replyWith } = fakeBridge([needsYou]);
    replyWith(async () => Promise.reject(new Error("ipc closed")));
    await renderDrawer(bridge, needsYou.id);
    await click(button("Approve and send"));
    expect(text('[role="status"]')).toBe("✕Could not send it: Error: ipc closed");
  });
});

describe("ItemDrawer switching items", () => {
  it("drops a command reply for the item shown before, with its notice and busy state", async () => {
    const { bridge, query, replyWith } = fakeBridge([needsYou, task]);
    const pending = deferred();
    replyWith(() => pending.promise);
    await renderDrawer(bridge, needsYou.id);
    await click(button("Approve and send"));
    await renderDrawer(bridge, task.id);
    expect(text('[role="tab"][aria-selected="true"]')).toBe("Steps");
    const queries = query.mock.calls.length;
    await act(async () => pending.resolve({ ok: false, error: { code: "stale_decision", message: "decision is not open" } }));
    expect(text(".drawer h2")).toBe(task.title);
    expect($('[role="status"]')).toBeNull();
    expect(button("Stop")?.disabled).toBe(false);
    // No refresh of the earlier item either.
    expect(query.mock.calls.length).toBe(queries);
  });

  it("drops an item query answer for the item shown before", async () => {
    const { bridge, query } = fakeBridge([needsYou, task]);
    const pending = deferred();
    query.mockImplementationOnce(() => pending.promise);
    await renderDrawer(bridge, needsYou.id);
    await renderDrawer(bridge, task.id);
    await act(async () => pending.resolve({ ok: true, data: { item: needsYou } }));
    expect(text(".drawer h2")).toBe(task.title);
  });
});

describe("ItemDrawer stop", () => {
  it("asks in the drawer first, then sends stop_item; never window.confirm", async () => {
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    const { bridge, command } = fakeBridge([task]);
    await renderDrawer(bridge, task.id);
    await click(button("Stop"));
    expect(command).not.toHaveBeenCalled();
    expect(text(".drawer-confirm p")).toBe("Stop this item? The agent is stopped and the item ends. You can't continue it later. Changed files stay in the worktree.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(button("Stop item"));
    expect(command).toHaveBeenCalledWith({ type: "stop_item", itemId: task.id });
    expect($(".drawer-confirm")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("goes back to the Stop link on Cancel or Esc, without closing the drawer", async () => {
    const { bridge, command } = fakeBridge([task]);
    const onClose = await renderDrawer(bridge, task.id);
    await click(button("Stop"));
    await click(button("Cancel"));
    expect($(".drawer-confirm")).toBeNull();
    expect(document.activeElement).toBe(button("Stop"));
    await click(button("Stop"));
    await key("Escape");
    expect($(".drawer-confirm")).toBeNull();
    expect(document.activeElement).toBe(button("Stop"));
    expect(onClose).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it("moves focus to the drawer when Cancel finds the Stop link gone because a card's own Stop arrived", async () => {
    const { bridge, push } = fakeBridge([task]);
    await renderDrawer(bridge, task.id);
    await click(button("Stop"));
    await push({ ...needsYou, id: task.id } as ItemRecord);
    await click(button("Cancel"));
    expect($(".drawer-confirm")).toBeNull();
    expect(document.activeElement).toBe($(".drawer"));
  });

  it("keeps focus in the drawer after a failed stop", async () => {
    const { bridge, replyWith } = fakeBridge([task]);
    replyWith(async () => ({ ok: false, error: { code: "internal", message: "boom" } }));
    await renderDrawer(bridge, task.id);
    await click(button("Stop"));
    // The confirmation goes away with the click, taking the focused button with it.
    await act(async () => {
      button("Stop item")?.click();
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(text('[role="status"]')).toBe("✕Could not send it: boom");
    expect(document.activeElement).toBe($(".drawer"));
  });

  it("on invalid_state, says the item had ended and queries it again", async () => {
    const { bridge, query, set, replyWith } = fakeBridge([task]);
    await renderDrawer(bridge, task.id);
    set({ ...task, state: "done" } as ItemRecord);
    replyWith(async () => ({ ok: false, error: { code: "invalid_state", message: "already ended" } }));
    await click(button("Stop"));
    await click(button("Stop item"));
    expect(text('[role="status"]')).toBe("!The item had already ended. The drawer shows the item as it is now.");
    // The item again, then, as it has ended, what it changed.
    expect(query.mock.calls.slice(-2).map(([q]) => q)).toEqual([
      { type: "item", itemId: task.id },
      { type: "item_diff", itemId: task.id },
    ]);
    expect(text(".drawer-state")).toBe("✓done");
  });
});

describe("ItemDrawer live updates", () => {
  it("follows item_updated events for its item and ignores other items", async () => {
    const { bridge, push } = fakeBridge([needsYou, task]);
    await renderDrawer(bridge, needsYou.id);
    await push({ ...task, title: "Another item" } as ItemRecord);
    expect(text(".drawer h2")).toBe("Orders API returns 500 after deploy");
    await push({ ...needsYou, title: "Orders API returns 500 after the 14:02 deploy" } as ItemRecord);
    expect(text(".drawer h2")).toBe("Orders API returns 500 after the 14:02 deploy");
  });

  it("keeps an event that arrives while the item query is in flight", async () => {
    const { bridge, query, listeners } = fakeBridge([needsYou]);
    const pending = deferred();
    query.mockImplementationOnce(() => pending.promise);
    await renderDrawer(bridge, needsYou.id);
    await act(async () => {
      for (const listener of listeners) listener({ kind: "event", seq: 1, event: { type: "item_updated", item: approved } });
    });
    await act(async () => pending.resolve({ ok: true, data: { item: needsYou } }));
    // A running item shows who works and what in place of the state line.
    expect(text(".activity")).toBe("Architect·working");
  });

  it("queries the item again after the engine connection comes back", async () => {
    const { bridge, query, set, reconnect } = fakeBridge([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    // Missed while away: the engine moved the item on.
    set(approved);
    await reconnect();
    expect(query.mock.calls.filter(([q]) => q.type === "item")).toHaveLength(2);
    expect($(".needs-you")).toBeNull();
    // A running item shows who works and what in place of the state line.
    expect(text(".activity")).toBe("Architect·working");
  });

  it("stops listening when it closes", async () => {
    const { bridge, listeners } = fakeBridge([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    expect(listeners.size).toBe(1);
    await act(async () => root.render(<></>));
    expect(listeners.size).toBe(0);
  });
});

describe("ItemDrawer in the app: open, focus and close", () => {
  const openFromList = async () => {
    const fake = fakeBridge([needsYou, task]);
    await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} />));
    const row = $$(".pl-row").find((el) => el.textContent?.includes(needsYou.title)) as HTMLButtonElement;
    row.focus();
    await click(row);
    return { ...fake, row };
  };

  it("opens from a list row, moves focus into the drawer and marks the row", async () => {
    const { row } = await openFromList();
    expect(text(".drawer h2")).toBe(needsYou.title);
    expect(document.activeElement).toBe($(".drawer"));
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("closes on Esc and gives focus back to the row that opened it", async () => {
    const { row } = await openFromList();
    await key("Escape");
    expect($(".drawer")).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row.hasAttribute("aria-current")).toBe(false);
  });

  it("closes with the close button and gives focus back to the row", async () => {
    const { row } = await openFromList();
    await click(button("Close"));
    expect($(".drawer")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("closes when the engine connection fails, never showing ids without their setup", async () => {
    const { row, setConnection } = await openFromList();
    await setConnection({ status: "failed", reason: "engine exited", logPath: "/tmp/engine.log", logTail: [] });
    expect($(".drawer")).toBeNull();
    expect(container.textContent).not.toContain("builtin/emergency-investigator");
    expect(row.isConnected).toBe(false);
  });

  it("approving through the drawer updates the drawer and the list row", async () => {
    const { push, command } = await openFromList();
    await click(button("Approve and send"));
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: needsYou.id, decisionId: DECISION_ID, choice: "approve" });
    await push(approved);
    expect($(".needs-you")).toBeNull();
    const row = $$(".pl-row").find((el) => el.textContent?.includes(needsYou.title));
    expect(row?.closest("section")?.getAttribute("aria-label")).toBe("Running");
  });
});

describe("item drawer with real-mode records", () => {
  it("lists each step's attempts and shows the commit the item made", async () => {
    const fake = fakeBridge([committed]);
    await renderDrawer(fake.bridge, committed.id);
    // An item that has ended opens on its output.
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Output");
    await showTab("Steps");
    expect($$(".step-attempt > .mono").map((el) => el.textContent)).toEqual(["✕attempt 1 · failed · sh check.sh exit 1", "✓attempt 2 · passed · 1 check passed"]);
    expect(text(".drawer-state")).toContain("commit 3f2a9c1 on tokama/0b9f3c1e");
  });

  it("links the sandbox help page in a failed attempt's line on the Steps tab", async () => {
    const page = "https://tokama.dev/docs/linux-sandbox";
    const detail = `Claude Code could not start its sandbox: x. How to allow it: ${page} Then check again.`;
    const failed = { ...committed, steps: [{ ...committed.steps[0]!, state: "failed", attempts: [{ attempt: 1, result: "run_failed", detail, checks: [] }] }] } as unknown as ItemRecord;
    await renderDrawer(fakeBridge([failed]).bridge, failed.id);
    await showTab("Steps");
    expect($$(".step-attempt a").map((a) => a.getAttribute("href"))).toEqual([page]);
  });

  it("asks the question with no kind label above it and offers its own choices", async () => {
    const asked = {
      ...task,
      state: "needs_you",
      decision: { id: DECISION_ID, kind: "run_failure", stepIndex: 1, question: "The run failed. Retry the step, or stop?", why: "The agent call timed out.", choices: [{ id: "retry_step", label: "Retry step" }, { id: "stop", label: "Stop" }] },
    } as unknown as ItemRecord;
    const fake = fakeBridge([asked]);
    await renderDrawer(fake.bridge, asked.id);
    expect($(".needs-you-kind")).toBeNull();
    expect($$(".needs-you .choices .btn").map((el) => el.textContent)).toEqual(["Retry step", "Stop"]);
    expect($(".drawer-actions")).toBeNull();
    await act(async () => ($$(".needs-you .choices .btn")[0] as HTMLButtonElement).click());
    expect(fake.command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: asked.id, decisionId: DECISION_ID, choice: "retry_step" });
  });
});

describe("item drawer: Finish", () => {
  const button = (label: string) => $$(".finish .btn, .finish-ended .btn-link").find((el) => el.textContent === label) as HTMLButtonElement;
  const key = (name: string) => act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  const openMenu = () => act(async () => ($(".finish-split-more") as HTMLButtonElement).click());
  const menuItem = (label: string) => $$("[role=menuitem]").find((el) => el.textContent?.startsWith(label)) as HTMLButtonElement;
  const discardFromMenu = async () => {
    await openMenu();
    await act(async () => menuItem("Discard…").click());
  };

  it("shows no Finish section for items that are not done or have no worktree", async () => {
    await renderDrawer(fakeBridge([committed]).bridge, committed.id);
    expect($(".finish")).toBeNull();
    await renderDrawer(fakeBridge([task]).bridge, task.id);
    expect($(".finish")).toBeNull();
  });

  it("offers one filled Finish button beside the item branch; Merge, Open PR and Discard… are its menu, and Merge and Open PR send finish_item", async () => {
    const fake = fakeBridge([finishable]);
    await renderDrawer(fake.bridge, finishable.id);
    expect(text(".finish-head")).toBe("Finishtokama/0b9f3c1e · 1 commit ahead of main");
    expect($$(".finish-split")).toHaveLength(1);
    expect($(".finish-split")?.getAttribute("data-variant")).toBe("filled");
    expect($(".finish-row")).toBeNull();
    expect(text(".finish-split-main")).toBe("Merge into main");
    expect($(".finish-split-more")?.getAttribute("aria-label")).toBe(`More ways to finish ${finishable.title}`);
    await openMenu();
    expect($$("[role=menuitem]").map((el) => el.textContent)).toEqual(["Merge into mainlocal merge, then clean up", "Open PRPush tokama/0b9f3c1e to github.com/northwind/orders-api and open a PR with gh", "Discard…"]);
    await act(async () => menuItem("Open PR").click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: finishable.id, action: "pull_request" });
    await act(async () => button("Merge into main").click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: finishable.id, action: "merge" });
    await fake.push({ ...finishable, finish: { ...finishable.finish!, running: "merge" } });
    expect(text(".finish-running")).toContain("Merging into main");
    expect(($(".finish-split-main") as HTMLButtonElement).disabled).toBe(true);
    expect(($(".finish-split-more") as HTMLButtonElement).disabled).toBe(true);
    await fake.push({ ...finishable, finish: { worktreeRemoved: true, merged: { baseBranch: "main", commit: "abcdef1234567890abcdef1234567890abcdef12" } } });
    expect($(".finish")).toBeNull();
    expect(text(".finish-ended-title")).toBe("merged: Merged into main · abcdef1");
    expect(text(".drawer-state")).toContain("· merged");
  });

  it("says a refused merge in place; a conflict offers Open PR instead", async () => {
    const refused = { ...finishable, finish: { ...finishable.finish!, failed: { action: "merge", reason: "conflict", detail: "The branch conflicts with main in README.md." } } } as unknown as ItemRecord;
    const fake = fakeBridge([refused]);
    await renderDrawer(fake.bridge, refused.id);
    expect(text(".finish-notice-title")).toBe("! main has moved and the merge has conflicts.");
    expect(text(".finish-notice-body")).toBe("The branch conflicts with main in README.md.");
    await act(async () => button("Open PR instead").click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: refused.id, action: "pull_request" });
  });

  it("asks before Discard, in place; Keep and Escape cancel without closing the drawer, Discard sends it", async () => {
    const fake = fakeBridge([finishable]);
    const onClose = await renderDrawer(fake.bridge, finishable.id);
    await discardFromMenu();
    expect(text(".finish-confirm-title")).toBe("Discard this work?");
    expect(text(".finish-confirm .finish-text")).toBe("Deletes the worktree and the branch tokama/0b9f3c1e with its 1 commit. The item and its log stay. This can't be undone.");
    expect(fake.command).not.toHaveBeenCalled();
    await key("Escape");
    expect($(".finish-confirm")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await discardFromMenu();
    await act(async () => ($$(".finish-confirm .btn").find((el) => el.textContent === "Keep") as HTMLButtonElement).click());
    expect(fake.command).not.toHaveBeenCalled();
    await discardFromMenu();
    await act(async () => ($$(".finish-confirm .btn").find((el) => el.textContent === "Discard") as HTMLButtonElement).click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: finishable.id, action: "discard" });
  });

  it("opens the Discard question at once when asked from the list", async () => {
    await act(async () => root.render(<ItemDrawer bridge={fakeBridge([finishable]).bridge} itemId={finishable.id} setup={setup} onClose={vi.fn()} request={{ seq: 1, discard: true }} />));
    expect(text(".finish-confirm-title")).toBe("Discard this work?");
  });

  it("turns Open PR off with gh's state and offers Check again; a refused command is said in the engine's words", async () => {
    const fake = fakeBridge([finishable]);
    const onCheckAgain = vi.fn();
    const loggedOut = { ...setup, health: { ...setup.health, gh: { installed: true, loggedIn: false } } } as Setup;
    await act(async () => root.render(<ItemDrawer bridge={fake.bridge} itemId={finishable.id} setup={loggedOut} onClose={vi.fn()} onCheckAgain={onCheckAgain} />));
    await openMenu();
    expect(menuItem("Open PR").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("Open PR").textContent).toBe("Open PRgh is installed but not logged in.");
    expect(text(".finish-off")).toBe("✕ logged out · run gh auth login in a terminalCheck again");
    await act(async () => ($(".finish-off .btn-link") as HTMLButtonElement).click());
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    fake.replyWith(async () => ({ ok: false, error: { code: "invalid_state", message: "Merge is still running." } }));
    await act(async () => button("Merge into main").click());
    expect(text(".drawer-notice")).toContain("Merge is still running.");
  });

  it("after a pull request: PR #12 open with its URL as text, and Remove worktree asks first", async () => {
    const pr = { ...finishable, finish: { ...finishable.finish!, pullRequest: { url: "https://github.com/northwind/orders-api/pull/12" } } } as ItemRecord;
    const fake = fakeBridge([pr]);
    await renderDrawer(fake.bridge, pr.id);
    expect(text(".finish-ended-title")).toBe("pull request: PR #12 open");
    expect(text(".finish-url")).toBe("https://github.com/northwind/orders-api/pull/12");
    expect($(".finish-ended a")).toBeNull();
    expect(text(".drawer-state")).toContain("· PR open");
    await act(async () => button("Remove worktree").click());
    await act(async () => ($$(".finish-confirm .btn").find((el) => el.textContent === "Discard") as HTMLButtonElement).click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: pr.id, action: "discard" });
  });

  it("a discarded item reads as discarded", async () => {
    const gone = { ...finishable, finish: { worktreeRemoved: true } } as ItemRecord;
    await renderDrawer(fakeBridge([gone]).bridge, gone.id);
    expect(text(".drawer-state")).toBe("⊘discarded");
    expect(text(".finish-ended-title")).toBe("discarded: Discarded");
  });

  it("shows engine text as text only", async () => {
    const hostile = { ...finishable, finish: { ...finishable.finish!, failed: { action: "merge", detail: "<img src=x onerror=alert(1)> conflict" } } } as unknown as ItemRecord;
    await renderDrawer(fakeBridge([hostile]).bridge, hostile.id);
    expect($(".finish img")).toBeNull();
    expect(text(".finish-notice-body")).toBe("<img src=x onerror=alert(1)> conflict");
  });
});

describe("a Done row's split button", () => {
  const showDone = async (items: ItemRecord[]) => {
    const fake = fakeBridge(items);
    await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={finishable.createdAt + 60_000} />));
    const done = $$(".filter-bar .segment").find((el) => el.textContent?.startsWith("Done")) as HTMLButtonElement;
    await act(async () => done.click());
    return fake;
  };
  const wrapOf = (itemId: string) => $$(".pl-row-wrap").find((el) => el.querySelector(".pl-row")?.getAttribute("data-item-id") === itemId)!;

  it("merges from the main part, and offers the three ways from ▾", async () => {
    const fake = await showDone([finishable, committed]);
    const wrap = wrapOf(finishable.id);
    expect(wrap.querySelector(".finish-split-main")?.textContent).toBe("Merge into main");
    // A done item without a worktree has no split button.
    expect(wrapOf(committed.id).querySelector(".finish-split")).toBeNull();
    await act(async () => (wrap.querySelector(".finish-split-main") as HTMLButtonElement).click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: finishable.id, action: "merge" });
    const more = wrap.querySelector(".finish-split-more") as HTMLButtonElement;
    expect(more.getAttribute("aria-label")).toBe(`More ways to finish ${finishable.title}`);
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect([...wrap.querySelectorAll("[role=menuitem]")].map((el) => el.textContent)).toEqual(["Merge into mainlocal merge, then clean up", "Open PRPush tokama/0b9f3c1e to github.com/northwind/orders-api and open a PR with gh", "Discard…"]);
    expect(document.activeElement?.textContent).toBe("Merge into mainlocal merge, then clean up");
    await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(wrap.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("Discard… opens the item with its Discard question; nothing is sent", async () => {
    const fake = await showDone([finishable]);
    const wrap = wrapOf(finishable.id);
    await act(async () => (wrap.querySelector(".finish-split-more") as HTMLButtonElement).click());
    await act(async () => ([...wrap.querySelectorAll("[role=menuitem]")].find((el) => el.textContent === "Discard…") as HTMLButtonElement).click());
    expect(text(".finish-confirm-title")).toBe("Discard this work?");
    expect(fake.command).not.toHaveBeenCalled();
  });

  it("after a finish, the row says how it ended where the steps were, and has no split button", async () => {
    await showDone([{ ...finishable, finish: { worktreeRemoved: false, pullRequest: { url: "https://github.com/northwind/orders-api/pull/12" } } } as ItemRecord]);
    const wrap = wrapOf(finishable.id);
    expect(wrap.querySelector(".pl-finish")?.textContent).toBe("↗pull request: PR #12 open");
    expect(wrap.querySelector(".pl-pipe")).toBeNull();
    expect(wrap.querySelector(".finish-split")).toBeNull();
  });
});

describe("Finish: review fixes", () => {
  const showDone = async (items: ItemRecord[]) => {
    const fake = fakeBridge(items);
    await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={finishable.createdAt + 60_000} />));
    await act(async () => ($$(".filter-bar .segment").find((el) => el.textContent?.startsWith("Done")) as HTMLButtonElement).click());
    return fake;
  };
  const wrap = () => $$(".pl-row-wrap").find((el) => el.querySelector(".pl-row")?.getAttribute("data-item-id") === finishable.id)!;
  const menuItems = () => [...wrap().querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
  const openMenu = () => act(async () => (wrap().querySelector(".finish-split-more") as HTMLButtonElement).click());
  const pickDiscard = () => act(async () => menuItems().find((el) => el.textContent === "Discard…")!.click());
  const key = (name: string) => act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));

  it("the Discard question goes when an action starts, and does not come back once nothing is left to discard", async () => {
    const fake = fakeBridge([finishable]);
    await renderDrawer(fake.bridge, finishable.id);
    await act(async () => ($(".finish-split-more") as HTMLButtonElement).click());
    await act(async () => ($$("[role=menuitem]").find((el) => el.textContent === "Discard…") as HTMLButtonElement).click());
    expect($(".finish-confirm")).not.toBeNull();
    await fake.push({ ...finishable, finish: { ...finishable.finish!, running: "merge" } });
    expect($(".finish-confirm")).toBeNull();
    await fake.push({ ...finishable, finish: { worktreeRemoved: true, merged: { baseBranch: "main", commit: "a".repeat(40) } } });
    expect($(".finish-confirm")).toBeNull();
  });

  it("Discard… from the row asks again after Keep", async () => {
    await showDone([finishable]);
    await openMenu();
    await pickDiscard();
    await act(async () => ($$(".finish-confirm .btn").find((el) => el.textContent === "Keep") as HTMLButtonElement).click());
    expect($(".finish-confirm")).toBeNull();
    await openMenu();
    await pickDiscard();
    expect(text(".finish-confirm-title")).toBe("Discard this work?");
  });

  it("a command the row sent and the engine refused opens the item with the engine's words", async () => {
    const fake = await showDone([finishable]);
    fake.replyWith(async () => ({ ok: false, error: { code: "invalid_request", message: "Local-only mode is on: nothing leaves this machine, so Tokama does not push." } }));
    await openMenu();
    await act(async () => menuItems().find((el) => el.textContent?.startsWith("Open PR"))!.click());
    expect(text(".drawer-notice")).toContain("Local-only mode is on");
    expect($(".drawer h2")?.textContent).toBe(finishable.title);
  });

  it("the menu: the arrow toggles it closed, arrows and Home/End move, an off Open PR is reachable but does nothing, a pick returns focus to the row", async () => {
    const loggedOut = { ...setup, health: { ...setup.health, gh: { installed: true, loggedIn: false } } } as Setup;
    const fake = fakeBridge([finishable]);
    const original = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q) => (q.type === "setup" ? { ok: true, data: loggedOut } : original(q)));
    await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={finishable.createdAt + 60_000} />));
    await act(async () => ($$(".filter-bar .segment").find((el) => el.textContent?.startsWith("Done")) as HTMLButtonElement).click());
    await openMenu();
    expect(menuItems().every((el) => el.tabIndex === -1)).toBe(true);
    const pr = menuItems()[1]!;
    expect(pr.getAttribute("aria-disabled")).toBe("true");
    expect(pr.textContent).toBe("Open PRgh is installed but not logged in.");
    await key("ArrowDown");
    expect(document.activeElement).toBe(pr);
    await key("End");
    expect(document.activeElement?.textContent).toBe("Discard…");
    await key("Home");
    expect(document.activeElement?.textContent).toBe("Merge into mainlocal merge, then clean up");
    await act(async () => pr.click());
    expect(fake.command).not.toHaveBeenCalled();
    // A mousedown on the arrow's own symbol, then its click: the menu closes, and stays closed.
    const more = wrap().querySelector(".finish-split-more") as HTMLButtonElement;
    await act(async () => {
      more.querySelector("span")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      more.click();
    });
    expect(wrap().querySelector("[role=menu]")).toBeNull();
    await openMenu();
    await act(async () => menuItems()[0]!.click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: finishable.id, action: "merge" });
    expect(document.activeElement).toBe(wrap().querySelector(".pl-row"));
  });
});

describe("Finish: git config or hooks changed", () => {
  const refused = {
    ...finishable,
    finish: {
      ...finishable.finish!,
      failed: {
        action: "merge",
        reason: "steering_changed",
        detail: "The repo's git config or hooks changed since the item started.",
        changes: [
          { what: "setting core.sshcommand", before: "ssh", after: "<b>touch pwned</b>; ssh" },
          { what: "hook pre-push added", after: "#!/bin/sh exit 0" },
        ],
      },
    },
  } as unknown as ItemRecord;

  it("lists each change with its values as text, and I made this change sends accept_git_changes", async () => {
    const fake = fakeBridge([refused]);
    await renderDrawer(fake.bridge, refused.id);
    expect(text(".finish-notice-title")).toBe("! The repo's git config or hooks changed.");
    expect($$(".finish-changes li").map((el) => el.textContent)).toEqual(["setting core.sshcommandwas sshnow <b>touch pwned</b>; ssh", "hook pre-push addednow #!/bin/sh exit 0"]);
    expect($(".finish-changes b")).toBeNull();
    // Taking the changes is the Finish button itself until it is done; Open PR and Discard… stay in its menu.
    const accept = $$(".finish .btn").find((el) => el.textContent === "I made this change") as HTMLButtonElement;
    expect(accept.classList.contains("finish-split-main")).toBe(true);
    // Merge and Open PR would be refused again: they wait in the menu until the changes are taken.
    await act(async () => ($(".finish-split-more") as HTMLButtonElement).click());
    expect($$("[role=menuitem]").slice(0, 2).map((el) => [el.getAttribute("aria-disabled"), el.querySelector(".finish-menu-note")?.textContent])).toEqual([
      ["true", "first say you made the git changes"],
      ["true", "first say you made the git changes"],
    ]);
    await act(async () => ($$("[role=menuitem]")[0] as HTMLButtonElement).click());
    expect(fake.command).not.toHaveBeenCalled();
    await act(async () => accept.click());
    expect(fake.command).toHaveBeenCalledWith({ type: "accept_git_changes", itemId: refused.id });
  });
});

describe("item drawer: the result card of an ended item", () => {
  const said = (over: Record<string, unknown> = {}) => ({ source: "headline", headline: "GET /orders/export now streams all orders of a date range as CSV.", points: [], morePoints: 0, bodyBytes: 90, ...over });
  /** A finished task whose Plan step (agent Architect) wrote `said` in its only attempt. */
  const withSaid = (words: unknown, over: Record<string, unknown> = {}) =>
    ({
      ...finishable,
      steps: [{ ...finishable.steps[0]!, doneWhen: "agent finishes", attempts: [{ attempt: 1, result: "passed", checks: [], said: words }] }],
      ...over,
    }) as unknown as ItemRecord;
  const rows = () => $$(".rc-row").map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);

  it("replaces the Committed note: what was checked and what was sent out, grey, then the one Finish button", async () => {
    await renderDrawer(fakeBridge([finishable]).bridge, finishable.id);
    expect($(".after")).toBeNull();
    expect($$(".result-card")).toHaveLength(1);
    expect(rows()).toEqual([
      ["Checked", "✓passed: 1 of 1 check passed, on attempt 2sh check.sh"],
      ["Sent out", "↗sent out: Code and diffs to Claude Code"],
    ]);
    // Only an exception has a colour.
    expect($$(".rc-mark").map((el) => el.getAttribute("data-tone"))).toEqual([null, null]);
    expect($$(".finish-split")).toHaveLength(1);
    expect($$(".finish .btn-primary, .result-card .btn-primary")).toHaveLength(0);
  });

  it("shows Changed and Risk: High with a symbol and a word, two reasons, and the rest behind +N more", async () => {
    const risky = withSaid(said(), {
      change: { files: 38, added: 1204, removed: 310, touches: [{ kind: "migrations", files: 2 }, { kind: "ci", files: 1 }] },
      risk: { level: "high", reasons: ["no_checks", "no_review_sensitive", "very_large"] },
    });
    await renderDrawer(fakeBridge([risky]).bridge, risky.id);
    expect(rows().map(([label]) => label)).toEqual(["Checked", "Reviewed", "Changed", "Sent out", "Risk"]);
    expect(rows()[2]).toEqual(["Changed", "38 files +1,204 −310 · 2 migrations · 1 CI file"]);
    const risk = () => $$(".rc-row")[4]!;
    expect(risk().querySelector(".rc-mark")?.textContent).toBe("!");
    expect(risk().querySelector(".rc-mark")?.getAttribute("data-tone")).toBe("fail");
    expect(risk().querySelector("dd")?.textContent).toContain("High · no checks ran on these changes; changes database migrations and CI and no second agent reviewed +1 more");
    expect(risk().querySelector("dt")?.getAttribute("title")).toContain("No AI judges risk");
    await click(button("+1 more"));
    expect(risk().querySelector(".rc-detail")?.textContent).toBe("more than 30 files or 800 changed lines");
    expect($$("button").some((el) => el.textContent === "+1 more")).toBe(false);
  });

  it("shows Low as plain text and Not rated with ? and its reason", async () => {
    const low = withSaid(said(), { change: { files: 3, added: 48, removed: 6 }, risk: { level: "low", reasons: ["small_checked"] } });
    await renderDrawer(fakeBridge([low]).bridge, low.id);
    expect(rows().at(-1)).toEqual(["Risk", "Low · small change, checks passed"]);
    expect($$(".rc-mark").map((el) => el.getAttribute("data-tone"))).not.toContain("fail");
    const binary = withSaid(said(), { change: { files: 212, unreadable: "binary_only" }, risk: { level: "not_rated", reasons: ["unreadable_change"] } });
    await renderDrawer(fakeBridge([binary]).bridge, binary.id);
    expect(rows().at(-1)).toEqual(["Risk", "?unknown: Not rated · Tokama could not read the change: binary files only"]);
    expect(rows().at(-2)).toEqual(["Sent out", "↗sent out: Code and diffs to Claude Code"]);
    expect(rows().find(([label]) => label === "Changed")?.[1]).toBe("212 files · binary, no line counts");
  });

  it("is on every ended item: failed and stopped say where they stopped, and the card shows after a merge", async () => {
    const failedItem = withSaid(said({ headline: "I could not make the retry test pass." }), {
      state: "failed",
      outcome: undefined,
      finish: undefined,
      steps: [{ ...finishable.steps[0]!, state: "failed", doneWhen: "agent finishes", attempts: [{ attempt: 1, result: "failed", checks: [{ command: "pnpm test", passed: false, exitCode: 1 }], said: said({ headline: "I could not make the retry test pass." }) }] }],
    });
    await renderDrawer(fakeBridge([failedItem]).bridge, failedItem.id);
    expect(text(".rc-headline")).toBe("✕failed: Stopped at Plan, step 1 of 1: pnpm test failed");
    expect(text(".rc-agent-said")).toBe("Architect said: I could not make the retry test pass.");
    expect(rows()[0]).toEqual(["Checked", "✕failed: 0 of 1 check passedpnpm test exit 1"]);
    expect($(".rc-mark[data-tone=fail]")).not.toBeNull();
    expect($(".finish")).toBeNull();
    const stopped = { ...failedItem, state: "stopped" } as ItemRecord;
    await renderDrawer(fakeBridge([stopped]).bridge, stopped.id);
    expect(text(".rc-headline")).toContain("Stopped at Plan");
  });

  it("says the agent's headline with its points and a Read more that opens that step's output", async () => {
    const item = withSaid(said({ points: ["Streams row by row.", "Not done: the column order."], bodyBytes: 2450 }));
    await renderDrawer(fakeBridge([item]).bridge, item.id);
    expect(text(".rc-who")).toBe("Architect says");
    expect(text(".rc-headline")).toBe("GET /orders/export now streams all orders of a date range as CSV.");
    expect($$(".rc-points li").map((el) => el.textContent)).toEqual(["Streams row by row.", "Not done: the column order."]);
    await showTab("Steps");
    await click(button("Read more · 2.4 KB →"));
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Output");
    expect($(".sec-head[aria-expanded=true]")).not.toBeNull();
  });

  it("is one line when the output is the headline: no points, no Read more", async () => {
    const item = withSaid(said());
    await renderDrawer(fakeBridge([item]).bridge, item.id);
    expect($(".rc-points")).toBeNull();
    expect($$(".rc-action")).toHaveLength(0);
  });

  it("shows a must-read with its reading time and a button to the reader, and does not shorten it", async () => {
    const item = withSaid(said({ headline: "Three ways to split the orders table by customer; I recommend a schema per customer.", bodyBytes: 3480, readMinutes: 6 }));
    const onRead = vi.fn();
    await act(async () => root.render(<ItemDrawer bridge={fakeBridge([item]).bridge} itemId={item.id} setup={setup} onClose={vi.fn()} onRead={onRead} />));
    expect(text(".rc-who")).toBe("Architect saysread · 6 min");
    expect(text(".rc-headline")).toBe("Three ways to split the orders table by customer; I recommend a schema per customer.");
    expect(button("Read more · 3.4 KB →")).toBeUndefined();
    // Finish is offered: it is the one filled button, so the write-up button is plain.
    expect(button("Read the write-up")?.className).toContain("btn-secondary");
    expect($$(".btn-primary")).toHaveLength(0);
    expect($(".result-card h3.rc-label")?.textContent).toBe("Result");
    await click(button("Read the write-up"));
    expect(onRead).toHaveBeenCalledWith(0);
    // With no Finish to offer (an ended item with no worktree) it is the filled one.
    const noFinish = { ...item, finish: undefined } as ItemRecord;
    await act(async () => root.render(<ItemDrawer bridge={fakeBridge([noFinish]).bridge} itemId={noFinish.id} setup={setup} onClose={vi.fn()} onRead={onRead} />));
    expect(button("Read the write-up")?.className).toContain("btn-primary");
  });

  describe("an Ask answer", () => {
    const answer = withSaid(said({ headline: "About half a day: one new endpoint and one test file.", points: ["4 files would change."], bodyBytes: 1020, readMinutes: 1 }), {
      templateId: "builtin/ask",
      kind: "investigation",
      title: "How hard is it to add CSV export?",
      text: "How hard is it to add CSV export to orders?",
      repoIds: ["orders-api"],
      outcome: { kind: "done", detail: "Nothing changed: the output is the result." },
      finish: { worktreeRemoved: true },
    });

    it("offers the answer and a quiet link that opens New work with the question, the answer and the repo", async () => {
      const onStartFrom = vi.fn();
      await act(async () => root.render(<ItemDrawer bridge={fakeBridge([answer]).bridge} itemId={answer.id} setup={setup} onClose={vi.fn()} onRead={vi.fn()} onStartFrom={onStartFrom} />));
      // Nothing is committed and nothing is offered to finish: the answer button is the filled one.
      expect(button("Read the answer")?.className).toContain("btn-primary");
      expect(button("Read the write-up")).toBeUndefined();
      expect(button("Start work from this…")?.className).toContain("btn-link");
      await click(button("Start work from this…"));
      expect(onStartFrom).toHaveBeenCalledWith({ repoId: "orders-api", text: "How hard is it to add CSV export to orders?\n\nThe answer: About half a day: one new endpoint and one test file.\n- 4 files would change." });
    });

    it("says the worktree was removed with nothing committed, and has no Discard", async () => {
      await renderDrawer(fakeBridge([answer]).bridge, answer.id);
      expect(text(".finish-ended-title")).toBe("done: Nothing committed");
      expect(button("Discard…")).toBeUndefined();
    });

    it("an item of another template has no such link", async () => {
      const other = { ...answer, templateId: "builtin/review-only" } as ItemRecord;
      await act(async () => root.render(<ItemDrawer bridge={fakeBridge([other]).bridge} itemId={other.id} setup={setup} onClose={vi.fn()} onRead={vi.fn()} onStartFrom={vi.fn()} />));
      expect(button("Start work from this…")).toBeUndefined();
      expect(button("Read the write-up")).toBeDefined();
    });
  });

  it("an agent with no headline shows the first lines the engine kept, and an old item asks for the first lines of its output", async () => {
    const lines = withSaid(said({ source: "first_lines", headline: "I updated the tax helper.", points: ["All tests pass now."], bodyBytes: 310 }));
    await renderDrawer(fakeBridge([lines]).bridge, lines.id);
    expect(text(".rc-who")).toBe("First lines of Architect's output");
    expect($$(".rc-lines span").map((el) => el.textContent)).toEqual(["I updated the tax helper.", "All tests pass now."]);
    expect(button("Read more · 310 B →")).toBeDefined();

    const fake = fakeBridge([finishable]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string; attempt?: number }) =>
      q.type === "step_output" ? { ok: true as const, data: { attempt: q.attempt ?? 2, text: "x".repeat(1500), truncated: false, summary: { kind: "lines", format: "none", lines: ["Added GET /orders/export.", "Checked the date range."] } } } : base(q),
    );
    await renderDrawer(fake.bridge, finishable.id);
    expect(text(".rc-who")).toBe("First lines of Architect's output");
    expect($$(".rc-lines span").map((el) => el.textContent)).toEqual(["Added GET /orders/export.", "Checked the date range."]);
    expect(button("Read more · 1.5 KB →")).toBeDefined();
  });

  it("shows agent text as text only", async () => {
    const item = withSaid(said({ headline: "<img src=x onerror=alert(1)> done", points: ["<b>bold</b>"], bodyBytes: 900 }));
    await renderDrawer(fakeBridge([item]).bridge, item.id);
    expect($(".result-card img")).toBeNull();
    expect($(".result-card b")).toBeNull();
    expect(text(".rc-headline")).toBe("<img src=x onerror=alert(1)> done");
  });
});

describe("ItemDrawer full view", () => {
  const CHANGE = "decision_00000000-0000-4000-8000-0000000000f1";
  const PLAN_TEXT = "## Plan\n\nAdd a `stock_reservations` table.\n\n## Risks\n\n- none";
  const change = {
    ...task,
    id: "item_1a2b3c4d-0020-4a1b-8c1d-000000000020",
    state: "needs_you",
    decision: {
      id: CHANGE,
      kind: "plan_approval",
      stepIndex: 0,
      question: "Approve this change and commit it?",
      why: "Local builder changed 2 files.",
      hasDiff: true,
      choices: [
        { id: "approve", label: "Approve and commit" },
        { id: "request_changes", label: "Request changes" },
      ],
    },
    steps: [{ name: "Change", stage: "review", state: "needs_you", agentId: "local-builder", data: "none", runs: 1, maxAttempts: 3, attempts: [{ attempt: 1, result: "passed", checks: [] }] }],
  } as unknown as ItemRecord;
  const plan = {
    ...change,
    id: "item_1a2b3c4d-0021-4a1b-8c1d-000000000021",
    decision: { ...change.decision!, id: "decision_00000000-0000-4000-8000-0000000000f2", hasDiff: undefined, question: "Approve this step's result?", choices: [{ id: "approve", label: "Approve" }, { id: "request_changes", label: "Request changes" }] },
    steps: [
      { name: "Plan", stage: "working", state: "needs_you", agentId: "architect", data: "none", runs: 1, maxAttempts: 3, attempts: [{ attempt: 1, result: "passed", checks: [] }] },
      { name: "Build", stage: "working", state: "pending", agentId: "local-builder", data: "none" },
    ],
  } as unknown as ItemRecord;
  const hunk = { header: "@@ -1,3 +1,3 @@", lines: [" keep", "-old one", "-old two", "+new one", " end"] };
  const diff = {
    files: [
      { path: "src/a.ts", status: "modified", added: 1, removed: 2, binary: false, cut: false, hunks: [hunk] },
      { path: "src/b.ts", status: "added", added: 1, removed: 0, binary: false, cut: false, hunks: [{ header: "@@ -0,0 +1 @@", lines: ["+only"] }] },
    ],
    moreFiles: 0,
    cut: false,
    worktree: { repoId: "orders-api", dir: ".tokama/wt/abc", branch: "tokama/abc", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" },
  };
  const bridgeFor = (items: ItemRecord[]) => {
    const fake = fakeBridge(items);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string; stepIndex?: number }) =>
      q.type === "decision_diff" ? { ok: true, data: diff } : q.type === "step_output" ? { ok: true, data: { attempt: 1, text: PLAN_TEXT, truncated: false } } : base(q),
    );
    return fake;
  };
  const show = (bridge: TokamaBridge, itemId: string, props: Partial<Parameters<typeof ItemDrawer>[0]> = {}) =>
    act(async () => root.render(<ItemDrawer bridge={bridge} itemId={itemId} setup={setup} onClose={vi.fn()} {...props} />));
  const full = (onCollapse = vi.fn(), wide = true, more: { reader?: { stepIndex: number }; onShowAll?: () => void } = {}) => ({ expanded: { back: "All work", wide, onCollapse, onShowAll: vi.fn(), ...more } });
  const selected = () => text('[role="tab"][aria-selected="true"]');
  const tab = (name: string) => $$('[role="tab"]').find((el) => el.textContent === name);
  const cells = (row: Element) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent).join("|");

  it("puts the one Finish button in the header row beside the card, which has two columns when there is room; Discard… opens its question below", async () => {
    const { bridge } = bridgeFor([finishable]);
    await show(bridge, finishable.id, full());
    expect($$(".finish-split")).toHaveLength(1);
    expect($(".ex-header .finish-split")).not.toBeNull();
    expect($(".finish .finish-split")).toBeNull();
    expect($(".result-card")?.getAttribute("data-columns")).toBe("true");
    await click($(".finish-split-more") ?? undefined);
    await click($$("[role=menuitem]").find((el) => el.textContent === "Discard…"));
    expect(text(".finish-confirm-title")).toBe("Discard this work?");
    // Asking again after Keep opens it again.
    await click($$(".finish-confirm .btn").find((el) => el.textContent === "Keep"));
    expect($(".finish-confirm")).toBeNull();
    await click($(".finish-split-more") ?? undefined);
    await click($$("[role=menuitem]").find((el) => el.textContent === "Discard…"));
    expect(text(".finish-confirm-title")).toBe("Discard this work?");
    // A request from the list that ends does not ask again.
    await show(bridge, finishable.id, { request: { seq: 1, discard: true }, ...full() });
    await click($$(".finish-confirm .btn").find((el) => el.textContent === "Keep"));
    await show(bridge, finishable.id, { request: { seq: 2, notice: "refused" }, ...full() });
    expect($(".finish-confirm")).toBeNull();
    await show(bridge, finishable.id, full(vi.fn(), false));
    expect($(".result-card")?.hasAttribute("data-columns")).toBe(false);
  });

  it("has the drawer's tabs: Steps, Output, Checks and Log, and Diff while a decision carries a diff or an ended item changed a repo", async () => {
    const { bridge } = bridgeFor([task, change]);
    await show(bridge, task.id, full());
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual(["Steps", "Output", "Checks", "Log"]);
    await show(bridge, change.id, full());
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual(["Steps", "Output", "Diff", "Checks", "Log"]);
  });

  it("has ⤢ left of ✕ only when the full view can open, and it asks for it", async () => {
    const { bridge } = bridgeFor([task]);
    await show(bridge, task.id);
    expect(button("Open full view")).toBeUndefined();
    const onExpand = vi.fn();
    await show(bridge, task.id, { onExpand });
    expect($$(".drawer-header > button").map((el) => el.getAttribute("aria-label"))).toEqual(["Open full view", "Close"]);
    await click(button("Open full view"));
    expect(onExpand).toHaveBeenCalledTimes(1);
    // The header's button goes with the drawer's header: focus moves to the full view, and back.
    await show(bridge, task.id, { onExpand, ...full() });
    expect(document.activeElement).toBe($(".expanded"));
    await click(button("Close full view, back to the list with the drawer open (Esc)"));
    await show(bridge, task.id, { onExpand });
    expect(document.activeElement).toBe($(".drawer"));
  });

  it("keeps the tab and the chosen file from the drawer to the full view and back, and focus follows", async () => {
    const { bridge } = bridgeFor([change]);
    const onExpand = vi.fn();
    await show(bridge, change.id, { onExpand });
    expect(selected()).toBe("Diff");
    await click($$(".dv-file")[1]);
    await click(button("Open diff in full view"));
    expect(onExpand).toHaveBeenCalledTimes(1);

    await show(bridge, change.id, { onExpand, ...full() });
    expect($(".drawer")).toBeNull();
    expect(document.activeElement).toBe($(".expanded"));
    expect(selected()).toBe("Diff");
    expect($$(".dv-file").map((el) => el.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect($('[role="table"]')?.getAttribute("aria-label")).toBe("Side-by-side diff of src/b.ts");
    // The drawer's ⤢ buttons are not in the full view.
    expect(button("Open full view")).toBeUndefined();
    expect(button("Open diff in full view")).toBeUndefined();

    await show(bridge, change.id, { onExpand });
    expect(document.activeElement).toBe($(".drawer"));
    expect(selected()).toBe("Diff");
    expect($$(".dv-file").map((el) => el.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect($('[role="table"]')?.getAttribute("aria-label")).toBe("Unified diff of src/b.ts");
  });

  it("shows the diff side by side when wide, a missing line as an empty cell named no line, and unified on request", async () => {
    const { bridge } = bridgeFor([change]);
    await show(bridge, change.id, full());
    const table = $('[role="table"]')!;
    expect(table.getAttribute("aria-label")).toBe("Side-by-side diff of src/a.ts");
    expect([...table.querySelectorAll('[role="columnheader"]')].map((el) => el.textContent)).toEqual(["Before · main", "After · worktree"]);
    expect($$(".dv-srow").map(cells)).toEqual(["@@ -1,3 +1,3 @@", "1||keep|1||keep", "2|−|old one|2|+|new one", "3|−|old two|||", "4||end|3||end"]);
    expect($$(".dv-srow")[3]?.querySelectorAll('[aria-label="no line"]').length).toBe(1);
    expect(text(".dv-by")).toBe("by Local builder · qwen3-coder:30b");
    expect($$(".dv[data-layout] .dv-switch .segment").map((el) => [el.textContent, el.getAttribute("aria-pressed")])).toEqual([
      ["Side by side", "true"],
      ["Unified", "false"],
    ]);
    await click(button("Unified"));
    expect($('[role="table"]')?.getAttribute("aria-label")).toBe("Unified diff of src/a.ts");
  });

  it("falls back to unified with a note when the main area is too narrow", async () => {
    const { bridge } = bridgeFor([change]);
    await show(bridge, change.id, full(vi.fn(), false));
    expect($(".dv")?.getAttribute("data-layout")).toBe("narrow");
    expect($('[role="table"]')?.getAttribute("aria-label")).toBe("Unified diff of src/a.ts");
    expect(text(".dv-switch")).toBe("Unified · too narrow for side by side");
    expect(button("Side by side")).toBeUndefined();
  });

  it("has a page header: ← back, the title as the page heading, state, template and repo, and ⤡ with Esc", async () => {
    const { bridge } = bridgeFor([plan]);
    const onCollapse = vi.fn();
    await show(bridge, plan.id, full(onCollapse));
    expect(text(".ex-back")).toBe("← All work");
    expect(text(".expanded h1")).toBe(plan.title);
    expect($(".expanded")?.getAttribute("aria-labelledby")).toBe($(".expanded h1")?.id);
    expect(text(".ex-meta")).toBe("⏸needs you · step 1 of 2 · Plantemplate Plan and buildorders-api");
    const collapse = button("Close full view, back to the list with the drawer open (Esc)")!;
    expect(collapse.textContent).toBe("Esc");
    await click(collapse);
    await click($(".ex-back")!);
    await key("Escape");
    expect(onCollapse).toHaveBeenCalledTimes(3);
  });

  it("pins the decision as a bar with its buttons, without the plan, and Approve sends the answer", async () => {
    const { bridge, command } = bridgeFor([plan]);
    await show(bridge, plan.id, full());
    const bar = $(".ex-decision")!;
    expect(bar.getAttribute("aria-label")).toBe("Needs you");
    expect(bar.querySelector(".step-output")).toBeNull();
    expect([...bar.querySelectorAll(".choices .btn")].map((el) => el.textContent)).toEqual(["Approve", "Request changes"]);
    await click(button("Approve"));
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: plan.id, decisionId: plan.decision!.id, choice: "approve" });
  });

  it("closes the Request changes note on Esc first, and Esc while typing in it does nothing", async () => {
    const { bridge } = bridgeFor([plan]);
    const onCollapse = vi.fn();
    await show(bridge, plan.id, full(onCollapse));
    await click(button("Request changes"));
    const note = $(".decision-note-text") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(note);
    await act(async () => note.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect($(".decision-note")).not.toBeNull();
    expect(onCollapse).not.toHaveBeenCalled();
    // A key goes to the focused element, as in the app.
    const cancel = button("Cancel")!;
    cancel.focus();
    await act(async () => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect($(".decision-note")).toBeNull();
    expect(onCollapse).not.toHaveBeenCalled();
    await key("Escape");
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("opens the full view on the tab the drawer has open, and Output shows it as a document with an outline and its agent", async () => {
    const { bridge } = bridgeFor([plan]);
    const onExpand = vi.fn();
    await show(bridge, plan.id, { onExpand });
    await click(tab("Output"));
    await click(button("Open full view"));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(selected()).toBe("Output");
    // In the drawer the Output tab has no outline.
    expect($(".ot-aside")).toBeNull();

    await show(bridge, plan.id, { onExpand, ...full() });
    expect(selected()).toBe("Output");
    const section = $('.ot-step[aria-label="Plan step · output"]')!;
    expect(section.querySelector(".ot-head")?.textContent).toBe(`Plan step · outputattempt 1 · ${new TextEncoder().encode(PLAN_TEXT).length} BCopy`);
    expect([...section.querySelectorAll(".st-heading")].map((el) => el.textContent)).toEqual(["Plan", "Risks"]);
    expect([...section.querySelectorAll(".ot-link")].map((el) => el.textContent)).toEqual(["Plan", "Risks"]);
    expect(section.querySelector(".ot-aside .al")?.textContent).toContain("Architect");
    // Build has not run: it has no output to show.
    expect($$(".ot-step").length).toBe(1);
    const scrolled = vi.fn();
    (section.querySelectorAll(".st-heading")[1] as HTMLElement).scrollIntoView = scrolled;
    await click(section.querySelectorAll(".ot-link")[1]);
    expect(scrolled).toHaveBeenCalledWith({ block: "start" });
  });

  it("keeps a note being written and an answered Discard question as they are when the view switches", async () => {
    const { bridge } = bridgeFor([plan, finishable]);
    await show(bridge, plan.id, { onExpand: vi.fn() });
    await click(button("Request changes"));
    const note = $(".decision-note-text") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Keep the old index.");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await show(bridge, plan.id, { onExpand: vi.fn(), ...full() });
    expect(($(".decision-note-text") as HTMLTextAreaElement | null)?.value).toBe("Keep the old index.");
    await show(bridge, plan.id, { onExpand: vi.fn() });
    expect(($(".decision-note-text") as HTMLTextAreaElement | null)?.value).toBe("Keep the old index.");

    const request = { seq: 1, discard: true as const };
    await show(bridge, finishable.id, { onExpand: vi.fn(), request });
    expect($(".finish-confirm")).not.toBeNull();
    await click(button("Keep"));
    await show(bridge, finishable.id, { onExpand: vi.fn(), request, ...full() });
    expect($(".finish-confirm")).toBeNull();
  });

  it("shows Output when a plan waits in the full view, also when opened from the header", async () => {
    const { bridge } = bridgeFor([plan]);
    await show(bridge, plan.id, { onExpand: vi.fn() });
    expect(selected()).toBe("Steps");
    await show(bridge, plan.id, { onExpand: vi.fn(), ...full() });
    expect(selected()).toBe("Output");
    // Once shown, the engineer may move on: the same question does not pull the tab back.
    await click(tab("Steps"));
    await show(bridge, plan.id, { onExpand: vi.fn(), ...full(vi.fn(), false) });
    expect(selected()).toBe("Steps");
  });

  it("shows Output in the full view for an approval whose diff lists no changed file", async () => {
    const empty = { ...plan, id: "item_1a2b3c4d-0022-4a1b-8c1d-000000000022", decision: { ...plan.decision!, hasDiff: true } } as ItemRecord;
    const fake = bridgeFor([empty]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string; stepIndex?: number }) => (q.type === "decision_diff" ? { ok: true, data: { ...diff, files: [], moreFiles: 0 } } : base(q)));
    await show(fake.bridge, empty.id, { onExpand: vi.fn(), ...full() });
    expect(selected()).toBe("Output");
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual(["Steps", "Output", "Checks", "Log"]);
  });

  describe("what the step's agent said", () => {
    const said = { source: "headline", headline: "Use a lookup table, not a join <b>per row</b>.", points: ["Not run on the staging data.", "Assumes prices are in cents."], morePoints: 1, bodyBytes: 2_400, readMinutes: 2 };
    const sayer = { ...plan, steps: [{ ...plan.steps[0]!, attempts: [{ attempt: 1, result: "passed", checks: [], said }] }, plan.steps[1]!] } as unknown as ItemRecord;

    it("opens the question card with 'Architect says', the headline in full and its read time, above the plan", async () => {
      const { bridge } = bridgeFor([sayer]);
      await show(bridge, sayer.id, { setup });
      expect(text(".needs-you .said-line")).toBe("Architect saysUse a lookup table, not a join <b>per row</b>.read · 2 min");
      expect($(".needs-you .said-line b")).toBeNull();
      const order = $$(".needs-you .said-line, .needs-you .step-output").map((el) => el.className.split(" ")[0]);
      expect(order).toEqual(["said-line", "step-output"]);
    });

    it("has no line on a question about an item whose step said nothing", async () => {
      const { bridge } = bridgeFor([plan]);
      await show(bridge, plan.id, { setup });
      expect($(".said-line")).toBeNull();
    });

    it("shows 'In short' above the reader: the headline, the points, and how many more there are in the output", async () => {
      const { bridge } = bridgeFor([sayer]);
      await show(bridge, sayer.id, full(vi.fn(), true, { reader: { stepIndex: 0 } }));
      const short = $('[aria-label="Reader"] .said-short')!;
      expect(short.querySelector(".said-short-title")?.textContent).toBe("In short");
      expect(short.querySelector(".said-headline")?.textContent).toBe("Use a lookup table, not a join <b>per row</b>.");
      expect([...short.querySelectorAll("li")].map((el) => el.textContent)).toEqual(["Not run on the staging data.", "Assumes prices are in cents."]);
      expect(short.querySelector(".said-more")?.textContent).toBe("+1 more in the output");
      expect(short.querySelector("b")).toBeNull();
    });

    it("has no 'In short' when the agent wrote no headline", async () => {
      const first = { ...sayer, steps: [{ ...sayer.steps[0]!, attempts: [{ attempt: 1, result: "passed", checks: [], said: { ...said, source: "first_lines" } }] }, sayer.steps[1]!] } as unknown as ItemRecord;
      const { bridge } = bridgeFor([first]);
      await show(bridge, first.id, full(vi.fn(), true, { reader: { stepIndex: 0 } }));
      expect($(".said-short")).toBeNull();
      expect($('[aria-label="Reader"] .ot')).not.toBeNull();
    });

    it("shows the headline on the Output tab's closed line for the step", async () => {
      const { bridge } = bridgeFor([sayer]);
      await show(bridge, sayer.id, full());
      await click(tab("Output"));
      // The step waits for its approval, so its section opens by itself; closed, it shows its line.
      await click($(".ot .sec-head") ?? undefined);
      expect(text(".ot .sec-sum")).toBe("Use a lookup table, not a join <b>per row</b>.");
    });
  });

  describe("the reader", () => {
    const reading = (onCollapse = vi.fn(), onShowAll = vi.fn(), stepIndex = 0) => full(onCollapse, true, { reader: { stepIndex }, onShowAll });

    it("shows one step's document with its outline and agent in place of the tabs, under the pinned decision", async () => {
      const { bridge } = bridgeFor([plan]);
      await show(bridge, plan.id, reading());
      expect($('[role="tab"]')).toBeNull();
      const reader = $('[aria-label="Reader"]')!;
      expect(reader.querySelector(".ot")?.getAttribute("data-reader")).toBe("true");
      expect(reader.querySelectorAll(".ot-step").length).toBe(1);
      expect([...reader.querySelectorAll(".st-heading")].map((el) => el.textContent)).toEqual(["Plan", "Risks"]);
      expect([...reader.querySelectorAll(".ot-label")].map((el) => el.textContent)).toEqual(["On this page", "Written by"]);
      expect(reader.querySelector(".ot-aside .al")?.textContent).toContain("Architect");
      expect($(".ex-decision")).not.toBeNull();
      // The question stays above the document in the page.
      expect($(".ex-decision")!.compareDocumentPosition(reader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("has All of this item, which asks for the tabs, and Esc and the back link, which close the reader", async () => {
      const { bridge } = bridgeFor([plan]);
      const onCollapse = vi.fn();
      const onShowAll = vi.fn();
      await show(bridge, plan.id, reading(onCollapse, onShowAll));
      await click(button("All of this item: Steps, Output, Log →"));
      expect(onShowAll).toHaveBeenCalledTimes(1);
      expect(onCollapse).not.toHaveBeenCalled();
      await key("Escape");
      await click($(".ex-back")!);
      expect(onCollapse).toHaveBeenCalledTimes(2);
    });

    it("answers from the pinned bar, and the document stays", async () => {
      const { bridge, command } = bridgeFor([plan]);
      await show(bridge, plan.id, reading());
      await click(button("Approve"));
      expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: plan.id, decisionId: plan.decision!.id, choice: "approve" });
      expect($('[aria-label="Reader"] .st-heading')).not.toBeNull();
    });

    it("says so when the step has written nothing, and still links to the whole item", async () => {
      const { bridge } = bridgeFor([plan]);
      await show(bridge, plan.id, reading(vi.fn(), vi.fn(), 1));
      expect(text('[aria-label="Reader"]')).toContain("This step has not written an output yet.");
      expect(button("All of this item: Steps, Output, Log →")).toBeDefined();
    });

    it("leaves the drawer's tab as it was when closed, and shows Output after All of this item", async () => {
      const { bridge } = bridgeFor([plan]);
      await show(bridge, plan.id, { onExpand: vi.fn() });
      expect(selected()).toBe("Steps");
      await show(bridge, plan.id, reading());
      await show(bridge, plan.id, { onExpand: vi.fn() });
      expect(selected()).toBe("Steps");
      await show(bridge, plan.id, reading());
      await show(bridge, plan.id, full());
      expect(selected()).toBe("Output");
    });
  });

  it("leaves focus where it is when the view switches without its button going away", async () => {
    const { bridge } = bridgeFor([task]);
    const outside = document.createElement("button");
    document.body.append(outside);
    await show(bridge, task.id, full());
    outside.focus();
    await show(bridge, task.id);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("keeps Stop and its confirmation in the full view", async () => {
    const { bridge, command } = bridgeFor([plan]);
    await show(bridge, plan.id, full());
    await click(tab("Steps"));
    await click(button("Stop"));
    await click(button("Stop item"));
    expect(command).toHaveBeenCalledWith({ type: "stop_item", itemId: plan.id });
  });
});

describe("tabsOf", () => {
  const BASE = "85a75e3c0ffee0000000000000000000000000ab";
  const tree = { files: [{ path: "a.ts", status: "modified" as const, added: 1, removed: 0, binary: false, cut: false, hunks: [] }], moreFiles: 0, cut: false };
  const change: ItemChange = { kind: "worktree", ...tree, worktree: { repoId: "orders-api" as never, dir: ".tokama/wt/a", branch: "tokama/a", baseCommit: BASE } };
  const loaded = (value: ItemChange) => ({ kind: "loaded", change: value }) as const;
  const withDiff = ["Steps", "Output", "Diff", "Checks", "Log"];
  const without = ["Steps", "Output", "Checks", "Log"];

  it.each([
    ["a done item that changed nothing", committed, loaded({ kind: "none" }), without],
    ["a done item not merged, with files", finishable, loaded(change), withDiff],
    ["a merged item", committed, loaded({ kind: "merged", ...tree, repoId: "orders-api" as never, baseBranch: "main", commit: "a".repeat(40), parent: BASE }), withDiff],
    ["a merged item whose commit is gone", committed, loaded({ kind: "gone", repoId: "orders-api" as never, commit: "a".repeat(40) }), withDiff],
    ["a discarded item with a commit", committed, { kind: "discarded" } as const, withDiff],
    ["a discarded item without a commit", task, undefined, without],
    ["an ended item while its change loads", finishable, { kind: "loading" } as const, without],
  ])("%s", (_label, item, state, tabs) => {
    expect(tabsOf(item, undefined, state)).toEqual(tabs);
  });

  it("hides Checks and Diff on an investigation, and keeps Diff for an open decision with a diff", () => {
    expect(tabsOf(needsYou, undefined, undefined)).toEqual(["Steps", "Output", "Log"]);
    expect(tabsOf(task, { kind: "loaded", diff: tree }, undefined)).toEqual(withDiff);
  });
});

describe("the Diff tab of an item not merged", () => {
  it("shows what the branch changed against its base, with no Merge button in the diff", async () => {
    const change = {
      kind: "worktree",
      files: [{ path: "src/a.ts", status: "modified", added: 3, removed: 1, binary: false, cut: false, hunks: [{ header: "@@ -1 +1 @@", lines: ["-old", "+new"] }] }],
      moreFiles: 0,
      cut: false,
      worktree: { repoId: "orders-api", dir: ".tokama/wt/a", branch: "tokama/0b9f3c1e", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" },
    };
    const fake = fakeBridge([finishable]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => (q.type === "item_diff" ? { ok: true, data: change } : base(q)));
    await act(async () => root.render(<ItemDrawer bridge={fake.bridge} itemId={finishable.id} setup={setup} onClose={vi.fn()} />));
    const diffTab = $$('[role="tab"]').find((el) => el.textContent === "Diff");
    expect(diffTab).toBeDefined();
    await click(diffTab);
    expect($$(".dv-head-line, .dv-head-sub").map((el) => el.textContent)).toEqual([
      "○Not merged yet·branch tokama/0b9f3c1e·1 file, +3 −1",
      "Compared with main at 85a75e3, where the item started.",
    ]);
    expect($$(".dv button").filter((el) => /merge/i.test(el.textContent ?? ""))).toEqual([]);
  });

  const oneFile = {
    kind: "worktree",
    files: [{ path: "src/a.ts", status: "modified", added: 3, removed: 1, binary: false, cut: false, hunks: [] }],
    moreFiles: 0,
    cut: false,
    worktree: { repoId: "orders-api", dir: ".tokama/wt/a", branch: "tokama/0b9f3c1e", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" },
  };
  const openDiff = async (item: ItemRecord) => {
    const fake = fakeBridge([item]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => (q.type === "item_diff" ? { ok: true, data: oneFile } : base(q)));
    await act(async () => root.render(<ItemDrawer bridge={fake.bridge} itemId={item.id} setup={setup} onClose={vi.fn()} />));
    const diffTab = $$('[role="tab"]').find((el) => el.textContent === "Diff");
    if (diffTab !== undefined) await click(diffTab);
    return fake;
  };
  const headLines = () => $$(".dv-head-line, .dv-head-sub").map((el) => el.textContent);

  it("says Merging while Merge runs, without asking for the change again, and goes back when the merge is refused", async () => {
    const fake = await openDiff(finishable);
    expect($(".dv-head-line")?.textContent).toContain("Not merged yet");
    const asked = () => fake.query.mock.calls.filter(([q]) => (q as { type: string }).type === "item_diff").length;
    const before = asked();
    await fake.push({ ...finishable, finish: { ...finishable.finish!, running: "merge" } } as ItemRecord);
    expect(headLines()).toEqual(["●Merging into main…·branch tokama/0b9f3c1e·1 file, +3 −1", "Compared with main at 85a75e3, where the item started."]);
    expect(asked()).toBe(before);
    await fake.push({ ...finishable, finish: { ...finishable.finish!, failed: { action: "merge", reason: "conflict", detail: "src/a.ts" } } } as ItemRecord);
    expect($(".dv-head-line")?.textContent).toContain("Not merged yet");
  });

  it("says Nothing was committed for a done item with no commit", async () => {
    await openDiff({ ...finishable, outcome: { kind: "done" } } as ItemRecord);
    expect(headLines()).toEqual(["○Nothing was committed·worktree tokama/0b9f3c1e·1 file, +3 −1", "Uncommitted changes left in the worktree, compared with main at 85a75e3."]);
  });

  it("keeps the Diff tab and its last answer while the change is asked for again after a merge", async () => {
    const worktree = { repoId: "orders-api", dir: ".tokama/wt/a", branch: "tokama/0b9f3c1e", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" };
    const tree = { files: [{ path: "src/a.ts", status: "modified", added: 3, removed: 1, binary: false, cut: false, hunks: [] }], moreFiles: 0, cut: false };
    const sha = "abc1234def5678900000000000000000000000ff";
    const second = deferred();
    let asked = 0;
    const fake = fakeBridge([finishable]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => {
      if (q.type !== "item_diff") return base(q);
      return ++asked === 1 ? { ok: true, data: { kind: "worktree", ...tree, worktree } } : second.promise;
    });
    await act(async () => root.render(<ItemDrawer bridge={fake.bridge} itemId={finishable.id} setup={setup} onClose={vi.fn()} />));
    const diffTab = $$('[role="tab"]').find((el) => el.textContent === "Diff") as HTMLElement;
    await click(diffTab);
    await act(async () => diffTab.focus());
    const merged ={ ...finishable, finish: { worktreeRemoved: true, merged: { baseBranch: "main", commit: sha } } } as ItemRecord;
    await fake.push(merged);
    expect(asked).toBe(2);
    expect($$('[role="tab"]').map((el) => el.textContent)).toContain("Diff");
    expect(text('[role="tab"][aria-selected="true"]')).toBe("Diff");
    expect(document.activeElement).toBe(diffTab);
    expect($(".dv-head-line")?.textContent).toContain("Merging into main…");
    await act(async () => second.resolve({ ok: true, data: { kind: "merged", ...tree, repoId: "orders-api", baseBranch: "main", commit: sha, parent: worktree.baseCommit } }));
    expect($(".dv-head-line")?.textContent).toContain("Merged as abc1234");
  });
});

describe("the card of a step that stopped", () => {
  const REVIEW = ["**Must change**", "1. **`src/start-card.css:31`: the card <b>shifts</b> while it fades.** Long reason.", "2. `src/a.ts:2` two", "3. three", "4. four", "", "VERDICT: changes"].join("\n");
  const summary = { kind: "verdict", verdict: "changes", mustFix: [{ ref: "src/start-card.css:31", text: "the card <b>shifts</b> while it fades" }, { ref: "src/a.ts:2", text: "two" }, { text: "three" }], more: 1, lines: [] };
  const withOutput = (reply: Reply, item: ItemRecord = stoppedReview) => {
    const fake = fakeBridge([item]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => (q.type === "step_output" ? reply : base(q)));
    return fake;
  };
  const facts = () => $$(".stopped-fact").map((fact) => [fact.querySelector("dt")?.textContent, fact.querySelector("dd")?.textContent]);
  const tab = (name: string) => $$('[role="tab"]').find((el) => el.textContent === name);

  it("says what the reviewer said, what ran after and why it stopped, as text, with the step on its button", async () => {
    const { bridge, query } = withOutput({ ok: true, data: { attempt: 1, text: REVIEW, truncated: false, summary } });
    await renderDrawer(bridge, stoppedReview.id);
    expect(query.mock.calls.filter(([q]) => (q as { type: string }).type === "step_output").map(([q]) => q)).toContainEqual({ type: "step_output", itemId: stoppedReview.id, stepIndex: 3, attempt: 1 });
    expect(text(".stopped-title")).toBe("⏸Review stopped at its limit");
    expect(facts()).toEqual([
      ["Reviewer said", "Asked for changes · 4 must fixsrc/start-card.css:31the card <b>shifts</b> while it fadessrc/a.ts:2twothree1 more in Reviewer’s notes"],
      ["Then", "✓Build fixed them in attempt 2 (checks passed)."],
      ["Why it stopped", "Review may run once per round, so it has not checked the fix."],
    ]);
    expect($(".stopped b")).toBeNull();
    expect($$(".stopped-items code").map((el) => el.textContent)).toEqual(["src/start-card.css:31", "src/a.ts:2"]);
    expect($$(".stopped .choices .btn").map((el) => [el.textContent, el.className])).toEqual([
      ["Run Review again", "btn btn-primary"],
      ["Stop", "btn btn-danger"],
      ["End: no action needed", "btn btn-link"],
    ]);
    expect($(".needs-you-kind")).toBeNull();
  });

  it("See Reviewer’s notes opens the Output tab; the stopped step's output starts unfolded in Steps", async () => {
    const { bridge } = withOutput({ ok: true, data: { attempt: 1, text: REVIEW, truncated: false, summary } });
    await renderDrawer(bridge, stoppedReview.id);
    const unfolded = $$(".step").map((li) => li.querySelector(".attempt-output button")?.getAttribute("aria-expanded") ?? null);
    expect(unfolded).toEqual(["false", "false", null, "true"]);
    await click(button("See Reviewer’s notes →"));
    expect(tab("Output")?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the notes once: a step the engineer closed stays closed when the tab is visited again", async () => {
    const { bridge } = withOutput({ ok: true, data: { attempt: 1, text: REVIEW, truncated: false, summary } });
    await renderDrawer(bridge, stoppedReview.id);
    await click(button("See Reviewer’s notes →"));
    const line = () => $$(".ot .sec-head").find((el) => el.textContent?.startsWith("Review"));
    expect(line()?.getAttribute("aria-expanded")).toBe("true");
    await click(line());
    await showTab("Steps");
    await showTab("Output");
    expect(line()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the stopped step's output when the stop arrives after the attempt's end", async () => {
    const quiet = { ...stoppedReview, state: "running", decision: undefined } as unknown as ItemRecord;
    const fake = withOutput({ ok: true, data: { attempt: 1, text: REVIEW, truncated: false, summary } }, quiet);
    await renderDrawer(fake.bridge, quiet.id);
    const review = () => $$(".step")[3]?.querySelector(".attempt-output button");
    expect(review()?.getAttribute("aria-expanded")).toBe("false");
    await fake.push(stoppedReview);
    expect(review()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("answers with the choice", async () => {
    const { bridge, command } = withOutput({ ok: true, data: { attempt: 1, text: REVIEW, truncated: false, summary } });
    await renderDrawer(bridge, stoppedReview.id);
    await click(button("Run Review again"));
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: stoppedReview.id, decisionId: stoppedReview.decision!.id, choice: "one_more_attempt" });
  });

  it("an empty output says so, and the link opens the Log", async () => {
    const failed = { ...stoppedReview, decision: { ...stoppedReview.decision!, kind: "run_failure", stopped: { limit: false, then: { kind: "none" }, why: "The agent call ran for 20 m (the limit)." } } } as ItemRecord;
    const { bridge } = withOutput({ ok: true, data: { attempt: 1, text: "", truncated: false, summary: { kind: "empty" } } }, failed);
    await renderDrawer(bridge, failed.id);
    expect(text(".stopped-title")).toBe("⏸Review failed");
    expect(facts()).toEqual([
      ["Reviewer said", "Nothing. The call ended before Reviewer wrote any output."],
      ["Then", "–Nothing ran after it."],
      ["Why it stopped", "The agent call ran for 20 m (the limit)."],
    ]);
    const scrolled = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrolled;
    await click(button("See the log →"));
    expect(tab("Log")?.getAttribute("aria-selected")).toBe("true");
    // The stopped step's line is open at its latest attempt, scrolled to the top and focused; the other steps stay closed.
    const lines = $$(".lg > .sec-wrap > .sec-list > .sec > .sec-h > .sec-head");
    expect(lines.map((line) => line.getAttribute("aria-expanded"))).toEqual(["false", "false", "true"]);
    expect(document.activeElement).toBe(lines[2]);
    expect(scrolled).toHaveBeenCalledWith({ block: "start" });
    expect($$(".lg .sec-sub > .sec-h > .sec-head").map((line) => line.getAttribute("aria-expanded"))).toEqual(["true"]);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    // Leaving the tab and coming back does not ask again: the line is only open, not focused.
    await showTab("Steps");
    (document.activeElement as HTMLElement | null)?.blur();
    await showTab("Log");
    expect(document.activeElement).not.toBe($$(".lg .sec-head")[2]);
  });

  it("an output in an unknown format shows its first lines as written", async () => {
    const lines = ["Looks mostly fine. Two things:", "1) the fade timing feels off", "2) <img src=x onerror=alert(1)>"];
    const { bridge } = withOutput({ ok: true, data: { attempt: 1, text: lines.join("\n"), truncated: false, summary: { kind: "lines", format: "no_verdict", lines } } });
    await renderDrawer(bridge, stoppedReview.id);
    expect($$(".stopped-lines > div").map((el) => el.textContent)).toEqual(lines);
    expect(text(".stopped-lines + .stopped-note")).toBe("First lines, as written. Tokama found no verdict in this output.");
    expect($(".stopped img")).toBeNull();
  });
});

describe("ItemDrawer live progress", () => {
  const NOW = 1_780_000_000_000;
  const live = {
    ...approved,
    steps: approved.steps.map((step, index) => (index === 3 ? { ...step, attempts: [{ attempt: 1, startedAt: NOW - 192_000, checks: [] }] } : step)),
  } as ItemRecord;
  const activity = (patch: Partial<ItemActivity>): ItemActivity =>
    ({ itemId: live.id, stepIndex: 3, attempt: 1, by: "agent", lastAction: { kind: "read", label: "reading src/tax/calculator.ts" }, lastEventAt: NOW, toolRunning: null, ...patch }) as ItemActivity;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("shows who works and what from the engine's activity, ticks every second, and follows activity events", async () => {
    const { bridge, listeners } = fakeBridge([live], new Map([[live.id, activity({})]]));
    await renderDrawer(bridge, live.id);
    expect(text(".activity")).toBe("Architect·reading src/tax/calculator.ts·3 m 12 s");
    expect($(".activity-head")?.getAttribute("title")).toBe("reading src/tax/calculator.ts");
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(text(".activity-time")).toBe("3 m 15 s");
    await act(async () => {
      for (const listener of listeners) listener({ kind: "event", seq: 9, event: { type: "item_activity", activity: activity({ lastAction: { kind: "run", label: "running pnpm test" }, toolRunning: { label: "running pnpm test", startedAt: NOW + 3_000 }, lastEventAt: NOW + 3_000 }) } });
    });
    await act(async () => vi.advanceTimersByTime(100_000));
    // A command shows its own time, and a long one is not quiet.
    expect(text(".activity")).toBe("Architect·running pnpm test·1 m 40 s");
    // Another item's activity changes nothing.
    await act(async () => {
      for (const listener of listeners) listener({ kind: "event", seq: 10, event: { type: "item_activity", activity: { ...activity({}), itemId: "item_other" } as ItemActivity } });
    });
    expect(text(".activity-tail")).toBe("pnpm test");
  });

  it("keeps an activity event that arrives while its query is in flight, and asks again after the connection comes back", async () => {
    const reading = (file: string) => activity({ lastAction: { kind: "read", label: `reading src/${file}` } });
    const activities = new Map([[live.id, reading("old.ts")]]);
    const { bridge, query, listeners, reconnect } = fakeBridge([live], activities);
    const answer = query.getMockImplementation()!;
    const pending = deferred();
    let hold = true;
    query.mockImplementation(async (q) => {
      if (q.type !== "activity" || !hold) return answer(q);
      hold = false;
      return pending.promise;
    });
    await renderDrawer(bridge, live.id);
    await act(async () => {
      for (const listener of listeners) listener({ kind: "event", seq: 1, event: { type: "item_activity", activity: reading("new.ts") } });
    });
    await act(async () => pending.resolve({ ok: true, data: { activity: reading("old.ts") } }));
    expect(text(".activity-tail")).toBe("new.ts");
    // Missed while away: the engine's activity moved on.
    activities.set(live.id, reading("after.ts"));
    await reconnect();
    expect(text(".activity-tail")).toBe("after.ts");
  });

  it("adds quiet in grey words after 2 minutes without an event, and drops it with the next event", async () => {
    const { bridge, listeners } = fakeBridge([live], new Map([[live.id, activity({ lastEventAt: NOW - 180_000 })]]));
    await renderDrawer(bridge, live.id);
    expect(text(".activity-quiet")).toBe("quiet for 3 m");
    await act(async () => {
      for (const listener of listeners) listener({ kind: "event", seq: 1, event: { type: "item_activity", activity: activity({ lastEventAt: NOW }) } });
    });
    expect($(".activity-quiet")).toBeNull();
  });

  it("draws the step track in words, and the running state line beside the activity line, with one breathing badge", async () => {
    const { bridge, push } = fakeBridge([live]);
    await renderDrawer(bridge, live.id);
    // Four long names are over the budget: the count form, with the whole list in the tooltip.
    expect(text(".track-count")).toBe("✓ 3 done · Propose a fix running");
    expect(text(".drawer-state")).toMatch(/^running · Propose a fix, step 4 of 4 · /);
    expect($(".drawer-state .mark")).toBeNull();
    expect($$("[data-breathe='true']")).toHaveLength(1);
    expect($(".activity .ag-badge")?.getAttribute("aria-label")).toBe("Agent Architect, running");
    await push(needsYou);
    expect($(".activity")).toBeNull();
    expect(text(".drawer-state")).toBe("⏸needs you · step 4 of 4 · Propose a fix");
    expect($$("[data-breathe='true']")).toHaveLength(0);
    expect(text(".track-count")).toBe("✓ 3 done · Propose a fix needs you");
  });

  it("names each step, its state and its agent in the track when it is short", async () => {
    const short = { ...live, steps: live.steps.slice(2).map((step, index) => ({ ...step, name: ["Find", "Fix"][index]! })) } as ItemRecord;
    await renderDrawer(fakeBridge([short]).bridge, short.id);
    expect($(".track-count")).toBeNull();
    expect($$(".track-step").map((el) => el.textContent)).toEqual(["Find✓doneLocal investigator", "FixrunningArchitect"]);
    expect($$(".track .mark-word").map((el) => el.textContent)).toEqual(["running"]);
    expect($$(".track .agent-name").map((el) => el.getAttribute("data-agent"))).toEqual(["2", "1"]);
  });

  it("shows Tokama's checks as ◐ before the activity line, with no badge", async () => {
    const checking = { ...live, steps: live.steps.map((step, index) => (index === 3 ? { ...step, stage: "verifying", agentId: undefined } : step)) } as ItemRecord;
    const { bridge } = fakeBridge([checking]);
    await renderDrawer(bridge, checking.id);
    expect($(".activity .ag-badge")).toBeNull();
    expect($(".activity .activity-mark")?.textContent).toBe("◐");
    expect(text(".drawer-state")).toMatch(/^◐checking/);
  });

  it("shortens a long track to its count form, with every step in a tooltip on focus", async () => {
    const many = {
      ...live,
      steps: Array.from({ length: 6 }, (_, index) => ({ ...live.steps[0], name: `A rather long step name number ${index + 1}`, state: index < 2 ? "passed" : index === 2 ? "running" : "pending" })),
    } as ItemRecord;
    const { bridge } = fakeBridge([many]);
    await renderDrawer(bridge, many.id);
    const count = $(".track-count") as HTMLElement;
    expect(count.textContent).toBe("✓ 2 done · A rather long step name number 3 running · 3 to go");
    expect(count.tabIndex).toBe(0);
    expect($(".track-tip")).toBeNull();
    await act(async () => count.focus());
    expect($(".track-tip")?.textContent).toContain("A rather long step name number 6");
  });

  it("shows each finished step's and attempt's time, and the time a step waited for you apart", async () => {
    const done = {
      ...committed,
      steps: committed.steps.map((step, index) =>
        index === 0 ? { ...step, durationMs: 252_000, waitedMs: 360_000, attempts: [{ attempt: 1, result: "passed", startedAt: NOW - 900_000, endedAt: NOW - 648_000, durationMs: 252_000, checks: [] }] } : step,
      ),
    } as ItemRecord;
    const { bridge } = fakeBridge([done]);
    await renderDrawer(bridge, done.id);
    await showTab("Steps");
    expect($$(".step")[0]?.querySelector(".step-detail")?.textContent).toMatch(/ · 4 m 12 s · waited 6 m for you$/);
    expect($$(".step")[0]?.querySelector(".step-attempt .mono")?.textContent).toBe("✓attempt 1 · passed · 4 m 12 s");
  });
});

describe("the Output tab folds per step", () => {
  const TEXT_OF_PLAN = "# Plan\nAdd GET /orders/export <script>alert(1)</script>";
  const withOutput = (items: ItemRecord[], summary: unknown = { kind: "lines", format: "none", lines: ["Add GET /orders/export."] }) => {
    const fake = fakeBridge(items);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string; attempt?: number }) => (q.type === "step_output" ? { ok: true as const, data: { attempt: q.attempt ?? 1, text: TEXT_OF_PLAN, truncated: false, summary } } : base(q)));
    return fake;
  };
  const stepLines = () => $$(".ot > .sec-wrap > .sec-list > .sec > .sec-h > .sec-head");

  it("opens an ended item on Output, with each step one closed line, its summary under it and none of the agent's text", async () => {
    const { bridge } = withOutput([committed]);
    await renderDrawer(bridge, committed.id);
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Output");
    expect(stepLines().map((line) => [line.querySelector(".sec-name")?.textContent, line.querySelector(".sec-agent")?.textContent, line.getAttribute("aria-expanded"), line.closest(".sec")?.querySelector(".sec-sum")?.textContent])).toEqual([
      ["Plan", "Architect", "false", "Add GET /orders/export."],
    ]);
    expect(text(".ot")).not.toContain("alert(1)");
    expect($(".step-output-text")).toBeNull();
    expect(stepLines()[0]?.querySelector(".sec-facts")?.textContent).toBe("2 attempts · 55 B");
    await click(stepLines()[0]);
    expect($(".step-output-text")?.textContent).toContain("Add GET /orders/export <script>alert(1)</script>");
    expect($(".ot script")).toBeNull();
    expect($(".ot .sec-sum")).toBeNull();
  });

  it("asks for each step's output once, for the line and the document together", async () => {
    const { bridge, query } = withOutput([committed]);
    await renderDrawer(bridge, committed.id);
    const asked = () => query.mock.calls.filter(([q]) => (q as { type: string }).type === "step_output").length;
    // The line asked for the output (and the result card above for its first lines); opening the step asks for nothing more.
    const before = asked();
    expect(before).toBe(2);
    await click(stepLines()[0]);
    expect(asked()).toBe(before);
  });

  it("keeps a change approval on Diff, and a running item on Steps", async () => {
    const { bridge } = withOutput([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Steps");
    const running = { ...committed, id: "item_1a2b3c4d-0030-4a1b-8c1d-000000000030", state: "running" } as ItemRecord;
    await renderDrawer(withOutput([running]).bridge, running.id);
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Steps");
  });

  it("opens only once per item: an item that ends while it is open stays on its tab", async () => {
    const running = { ...committed, id: "item_1a2b3c4d-0031-4a1b-8c1d-000000000031", state: "running" } as ItemRecord;
    const fake = withOutput([running]);
    await renderDrawer(fake.bridge, running.id);
    await fake.push({ ...running, state: "done" } as ItemRecord);
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Steps");
  });

  it("reaches every step line with Tab: each is a button", async () => {
    const { bridge } = withOutput([committed]);
    await renderDrawer(bridge, committed.id);
    expect(stepLines().every((line) => line.tagName === "BUTTON" && (line as HTMLButtonElement).tabIndex === 0)).toBe(true);
  });
});

describe("ItemDrawer usage", () => {
  const withUsage = (usage: ItemUsage) => fakeBridge([stoppedReview], new Map(), new Map([[stoppedReview.id, usage]]));
  const fact = () => text(".drawer-state")?.replace(/\s+/g, " ");

  it("says what the item took of the weekly limit on a plan, and never a dollar figure", async () => {
    await renderDrawer(withUsage({ tokens: 212_000, shares: [{ cliId: "claude-code", sharePercent: 1.2 }] }).bridge, stoppedReview.id);
    expect(fact()).toContain("· ~1.2% of weekly limit");
    expect(fact()).not.toContain("$");
  });

  it("names each tool when the item ran on two, and never adds their shares", async () => {
    await renderDrawer(withUsage({ tokens: 212_000, shares: [{ cliId: "claude-code", sharePercent: 1.2 }, { cliId: "codex-cli", sharePercent: 0.4 }] }).bridge, stoppedReview.id);
    expect(fact()).toContain("~1.2% of Claude Code weekly limit");
    expect(fact()).toContain("~0.4% of Codex CLI weekly limit");
    expect(fact()).not.toContain("1.6%");
  });

  it("says tokens when no share can be told, and the real cost with an API key", async () => {
    await renderDrawer(withUsage({ tokens: 212_000 }).bridge, stoppedReview.id);
    expect(fact()).toContain("212k tokens");
    await renderDrawer(withUsage({ tokens: 212_000, costUsd: 0.42 }).bridge, stoppedReview.id);
    expect(fact()).toContain("· $0.42");
    expect(fact()).not.toContain("≈");
    await renderDrawer(withUsage({ tokens: 212_000, costUsd: 0.42, costEstimated: true }).bridge, stoppedReview.id);
    expect(fact()).toContain("≈ $0.42");
  });

  it("keeps the plan share when another tool of the item was billed per use", async () => {
    await renderDrawer(withUsage({ tokens: 212_000, shares: [{ cliId: "claude-code", sharePercent: 1.2 }], costUsd: 0.42 }).bridge, stoppedReview.id);
    expect(fact()).toContain("~1.2% of Claude Code weekly limit");
    expect(fact()).toContain("$0.42");
  });

  it("says nothing for an item with no recorded calls", async () => {
    await renderDrawer(fakeBridge([stoppedReview]).bridge, stoppedReview.id);
    expect($(".usage-fact")).toBeNull();
  });

  it("puts what a step's retries took under its line on the Log tab", async () => {
    await renderDrawer(withUsage({ tokens: 212_000, retries: [{ stepIndex: 1, attempts: [2, 3], tokensPercent: 60, failingCheck: "pnpm test" }] }).bridge, stoppedReview.id);
    await showTab("Log");
    const lines = $$(".lg > .sec-wrap > .sec-list > .sec > .sec-h > .sec-head");
    await click(lines[1]);
    expect(text(".lg-retries")).toBe("Attempts 2 and 3 used 60% of this item's tokens · failing check: pnpm test");
    expect($$(".lg-retries")).toHaveLength(1);
  });
});

describe("ItemDrawer: an answer that needs no change", () => {
  const typeNote = (value: string) =>
    act(async () => {
      const note = $(".decision-note-text") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, value);
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("the card asks to finish with the answer: Finish is the filled button, no Approve, Stop in danger, and what follows is said", async () => {
    await renderDrawer(fakeBridge([noChangeAsked]).bridge, noChangeAsked.id);
    expect(text(".needs-you-question")).toBe("⏸No change needed. Finish with this answer?");
    expect($$(".needs-you .choices .btn").map((el) => [el.textContent, el.className.match(/btn-(\w+)/)?.[1]])).toEqual([
      ["Finish, keep the answer", "primary"],
      ["Build anyway…", "secondary"],
      ["Stop", "danger"],
    ]);
    // The card has its own Stop, so the drawer shows none.
    expect($$(".drawer-actions button").map((el) => el.textContent)).toEqual([]);
    expect($$(".needs-you .rc-row").map((el) => el.textContent)).toEqual(["ThenThe item ends as done · Build and Review do not run", "Changesnone · 0 files changed, nothing is committed"]);
  });

  it("Finish sends the answer at once; Build anyway asks for a note first and sends it, and cannot send an empty one", async () => {
    const { bridge, command } = fakeBridge([noChangeAsked]);
    await renderDrawer(bridge, noChangeAsked.id);
    await click(button("Finish, keep the answer"));
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: noChangeAsked.id, decisionId: noChangeAsked.decision!.id, choice: "no_action_needed" });
    command.mockClear();

    await click(button("Build anyway…"));
    expect(text(".decision-note label")).toBe("What should be built?");
    expect(text(".decision-note-hint")).toBe('Architect plans again with your note. You are asked "Build it this way?" before anything is built.');
    expect($$(".decision-note .btn").map((el) => el.textContent)).toEqual(["Send and plan", "Cancel"]);
    expect(($(".decision-note .btn") as HTMLButtonElement).disabled).toBe(true);
    await typeNote("   ");
    expect(($(".decision-note .btn") as HTMLButtonElement).disabled).toBe(true);
    await typeNote("  Yes, add it. CSV only.  ");
    await click(button("Send and plan"));
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: noChangeAsked.id, decisionId: noChangeAsked.decision!.id, choice: "request_changes", note: "Yes, add it. CSV only." });
  });

  it("after Finish, the card says done with no change, the answer stays, and Start work from this opens New work", async () => {
    const onStartFrom = vi.fn();
    await act(async () => root.render(<ItemDrawer bridge={fakeBridge([noChangeDone]).bridge} itemId={noChangeDone.id} setup={setup} onClose={vi.fn()} onStartFrom={onStartFrom} />));
    expect(text(".rc-label")).toBe("Done · no change needed");
    expect(text(".rc-headline")).toBe(noChangeDone.steps[0]!.attempts![0]!.said!.headline);
    expect($$(".rc-points li").map((el) => el.textContent)).toHaveLength(2);
    expect($$(".rc-row").map((el) => el.textContent)).toEqual([
      "Changednone · 0 files changed, nothing committed · the worktree is removed",
      "RanPlan only · Build and Review did not run",
      expect.stringMatching(/^Sent out/),
    ]);
    expect($(".result-card")?.textContent).toContain("Read the answer");
    expect(text(".finish-ended-title")).toContain("Nothing committed");
    expect($$("button").some((el) => el.textContent?.startsWith("Discard"))).toBe(false);
    await click(button("Start work from this…"));
    expect(onStartFrom).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("The answer: About half a day") }));
  });

  it("an item that ended with the quiet End: no action needed keeps the ordinary result card", async () => {
    const plain = { ...noChangeDone, steps: noChangeDone.steps.map((step, index) => (index === 0 ? { ...step, attempts: [{ attempt: 1, result: "passed", checks: [] }] } : step)) } as unknown as ItemRecord;
    await renderDrawer(fakeBridge([plain]).bridge, plain.id);
    expect(text(".rc-label")).toBe("Result");
  });
});

describe("cardOffersStop", () => {
  const choice = (id: string) => ({ id, label: id });
  const decision = (extra: Record<string, unknown>) => ({ ...needsYou.decision!, ...extra }) as unknown as Decision;
  it("is false for a change approval, whose card drops Stop", () => {
    expect(cardOffersStop(decision({ hasDiff: true, choices: [choice("approve"), choice("request_changes"), choice("stop")] }))).toBe(false);
  });
  it("is true when the card lists Stop", () => {
    expect(cardOffersStop(decision({ choices: [choice("retry_step"), choice("stop")] }))).toBe(true);
  });
  it("is false when no choice is Stop", () => {
    expect(cardOffersStop(decision({ choices: [choice("approve"), choice("request_changes")] }))).toBe(false);
  });
});
