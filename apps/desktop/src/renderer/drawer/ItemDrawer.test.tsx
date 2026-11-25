// @vitest-environment happy-dom
import type { ItemRecord, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { App } from "../App.js";
import { approved, committed, DECISION_ID, finishable, needsYou, setup, task } from "../testing/drawer.js";
import { ItemDrawer } from "./ItemDrawer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/**
 * A bridge over a set of items: `setup`, `board` and `item` answer from it, commands answer
 * with `commandReply` (null by default), and events are pushed by hand to every listener.
 */
function fakeBridge(start: ItemRecord[]) {
  const store = new Map<string, ItemRecord>(start.map((item) => [item.id, item]));
  const eventListeners = new Set<(event: BridgeEvent) => void>();
  const connectionListeners = new Set<(state: ConnectionState) => void>();
  let commandReply: (command: { type: string }) => Promise<Reply> = async () => ({ ok: true, data: null });
  const query = vi.fn(async (q: { type: string; itemId?: string }): Promise<Reply> => {
    if (q.type === "setup") return { ok: true, data: setup };
    if (q.type === "board") return { ok: true, data: { items: [...store.values()] } };
    const item = q.itemId === undefined ? undefined : store.get(q.itemId);
    if (q.type === "item" && item) return { ok: true, data: { item } };
    return { ok: false, error: { code: "not_found", message: `no item ${String(q.itemId)}` } };
  });
  const command = vi.fn((c: { type: string }) => commandReply(c));
  const bridge = {
    getConnection: vi.fn(async (): Promise<ConnectionState> => ({ status: "connected", engineId: "e-1" })),
    onConnection: vi.fn((listener: (state: ConnectionState) => void) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    }),
    query,
    command,
    saveLayout: vi.fn(async () => undefined),
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
const key = (name: string) => act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
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
    expect($(".drawer-state .mark")?.getAttribute("aria-hidden")).toBe("true");
    expect($("aside.drawer")?.getAttribute("aria-labelledby")).toBe($(".drawer h2")?.id);
  });

  it("shows the needs-you note: question, why, the exact summary and a button per choice", async () => {
    await renderDrawer(fakeBridge([needsYou]).bridge, needsYou.id);
    expect(text(".needs-you-question")).toBe("⏸Send the redacted findings summary to Architect on Claude Code?");
    expect(text(".needs-you-why")).toBe("Propose a fix runs on a cloud agent; its data rule sends a summary after your approval.");
    expect(text(".cloud-summary-label")).toBe("Will be sentNothing has been sent yet");
    expect(text(".cloud-summary-text")).toBe(needsYou.decision?.summaryText);
    expect($$(".needs-you .choice").map((el) => [el.textContent, el.className])).toEqual([
      ["Approve and send", "choice primary"],
      ["Stop", "choice"],
    ]);
  });

  it("shows each step with its state, agent dot and name, where it runs and its detail", async () => {
    await renderDrawer(fakeBridge([needsYou]).bridge, needsYou.id);
    const steps = $$(".step").map((li) => ({
      mark: li.querySelector(".mark")?.textContent,
      name: li.querySelector(".step-name")?.textContent,
      dot: li.querySelector(".dot")?.getAttribute("data-dot"),
      where: li.querySelector(".step-where")?.textContent,
      detail: li.querySelector(".step-detail")?.textContent,
    }));
    expect(steps).toEqual([
      { mark: "✓", name: "Triage, passed", dot: "2", where: "Local investigator · local", detail: "scope: orders-api, last 2 h" },
      {
        mark: "✓",
        name: "Query logs and metrics, passed",
        dot: "2",
        where: "Local investigator · local · App Insights (query), Postgres (read-only)",
        detail: "6 queries · 41 rows",
      },
      { mark: "✓", name: "Find the cause, passed", dot: "2", where: "Local investigator · local", detail: undefined },
      {
        mark: "⏸",
        name: "Propose a fix, needs you",
        dot: "1",
        where: "Architect · cloud · sees your approved summary only",
        detail: "waits for your approval of the cloud step",
      },
    ]);
  });

  it("has the tabs of an investigation; the others than Steps say their data comes later", async () => {
    await renderDrawer(fakeBridge([needsYou]).bridge, needsYou.id);
    expect($$('[role="tab"]').map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["Steps", "true"],
      ["Evidence", "false"],
      ["Findings", "false"],
      ["Log", "false"],
    ]);
    await click(button("Evidence"));
    expect(text('[role="tabpanel"]')).toBe("Evidence comes later: the engine does not send this data yet.");
    expect($(".step")).toBeNull();
    await act(async () => $('[role="tablist"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(text('[role="tab"][aria-selected="true"]')).toBe("Findings");
    expect(document.activeElement?.textContent).toBe("Findings");
  });

  it("adds Diff and Checks for a task", async () => {
    await renderDrawer(fakeBridge([task]).bridge, task.id);
    expect($$('[role="tab"]').map((tab) => tab.textContent)).toEqual(["Steps", "Evidence", "Findings", "Log", "Diff", "Checks"]);
    expect(text(".drawer-kind")).toBe("▣ Task · Plan and build · local + cloud");
    expect($(".needs-you")).toBeNull();
    expect($$(".step-where").map((el) => el.textContent)).toEqual([
      "Architect · cloud · sees the repo and the diff",
      "Local builder · local",
      "Tokama · local",
      "Reviewer · cloud · sees the repo and the diff",
    ]);
    expect($$(".drawer-actions button").map((el) => [el.textContent, el.className, el.getAttribute("aria-disabled")])).toEqual([["Stop", "choice danger", null]]);
  });

  it("shows only the actions that work: Stop while the item runs, no actions once it has ended", async () => {
    const { bridge, push } = fakeBridge([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    expect($$(".drawer-actions button").map((el) => el.textContent)).toEqual(["Stop"]);
    expect(document.body.textContent).not.toMatch(/Open worktree|Add a hint/);
    await push({ ...approved, state: "done" } as ItemRecord);
    expect($(".drawer-actions")).toBeNull();
    expect(text(".drawer-state")).toBe("✓done");
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
    expect($$(".drawer img, .drawer b, .drawer script, .drawer em, .drawer i")).toEqual([]);
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
      question: "Approve this change and commit it?",
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
    expect(text(".needs-you-kind")).toBe("Change approval");
    expect(text(".needs-you-question")).toBe("⏸Approve this change and commit it?");
    expect($$(".needs-you .choice").map((el) => el.textContent)).toEqual(["Approve and commit", "Request changes"]);
    expect(text(".dv-summary")).toBe("6 files+1,221 −314·tokama/abcfrom main 85a75e3");
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
    expect(text(".dv-panel-head")).toBe("src/a.tsmodified · +1 −1Open in your editor ↗Opening a file from Tokama comes later. Open the worktree folder in your editor.");
    // The open button is not there yet, and says so to every reader, not only on hover.
    const open = $(".dv-open")!;
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(open.getAttribute("aria-describedby")!)?.textContent).toBe("Opening a file from Tokama comes later. Open the worktree folder in your editor.");
    expect(rows()).toEqual(["|||@@ -4,2 +4,2 @@ function total() {", "4|4||keep", "5||−|<img src=x onerror=\"alert(1)\">", "|5|+|<b>bold</b>", "|||\\ No newline at end of file"]);
    expect($$(".dv-row [aria-label]").map((el) => el.getAttribute("aria-label"))).toEqual(["unchanged", "removed", "added"]);
    expect($$(".drawer img, .drawer b")).toEqual([]);
  });

  it("says why a binary or too-large file is not drawn, and where to find it", async () => {
    const { bridge } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    await pick("logo.png");
    expect(text(".dv-note")).toBe("Binary file, not shown here.Open it in your editor or an image viewer to compare.In repo orders-api: .tokama/wt/abc/logo.pngOpen in your editor ↗Opening a file from Tokama comes later. Open the worktree folder in your editor.");
    await pick("package-lock.json");
    expect(text(".dv-note-head")).toBe("Too large to show here.");
    expect($$(".dv-note-text")[0]?.textContent).toBe("1,533 changed lines; the drawer shows files up to 1,000 changed lines. Open it in your editor to review.");
    expect($(".dv-open")?.getAttribute("aria-disabled")).toBe("true");
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
    expect(text(".drawer-panel .drawer-error")).toBe("✕Could not load the change: Decision is not open.");
  });

  it("Request changes opens a note for the agent's next run in place of the buttons; Cancel brings them back", async () => {
    const { bridge, command } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    await click(button("Request changes"));
    expect(command).not.toHaveBeenCalled();
    expect($$(".needs-you .choice").map((el) => el.textContent)).toEqual(["Send to Local builder", "Cancel"]);
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

  it("after the decision: the step running again with your note, then the commit", async () => {
    const again = { ...waiting, state: "running", decision: undefined, steps: [{ ...waiting.steps[0]!, state: "running", changesNote: "Keep the old name.", runs: 2, attempts: [{ attempt: 1, result: "passed", checks: [] }, { attempt: 2, checks: [] }] }] } as unknown as ItemRecord;
    const { bridge, push } = withDiff({ ok: true, data: diff }, [again]);
    await renderDrawer(bridge, again.id);
    expect(text(".after")).toBe("●Local builder is making your changes · run 2 of 3Your note: \"Keep the old name.\"");
    await push({ ...again, state: "done", steps: [{ ...again.steps[0]!, state: "passed" }], outcome: { kind: "done", commits: [{ repoId: "orders-api", commit: "3f9c2e1d4e5f60718293a4b5c6d7e8f901234567", branch: "tokama/abc" }] } } as unknown as ItemRecord);
    expect(text(".after")).toBe("✓Committed · 3f9c2e1Paginate the orders list · on tokama/abc · Done");
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
    expect($$(".needs-you .choice").every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => pending.resolve({ ok: true, data: null }));
    await push(approved);
    expect($(".needs-you")).toBeNull();
    expect(text(".drawer-state")).toBe("●running · step 4 of 4 · Propose a fix");
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
    expect($$(".needs-you .choice").every((el) => !(el as HTMLButtonElement).disabled)).toBe(true);
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
    await click(button("Evidence"));
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
    expect(text(".drawer-confirm p")).toBe("Stop this item? Its agent is stopped; what is recorded so far is kept.");
    expect(document.activeElement?.textContent).toBe("Keep running");
    await click(button("Stop item"));
    expect(command).toHaveBeenCalledWith({ type: "stop_item", itemId: task.id });
    expect($(".drawer-confirm")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("goes back to the Stop link on Keep running or Esc, without closing the drawer", async () => {
    const { bridge, command } = fakeBridge([task]);
    const onClose = await renderDrawer(bridge, task.id);
    await click(button("Stop"));
    await click(button("Keep running"));
    expect($(".drawer-confirm")).toBeNull();
    expect(document.activeElement).toBe(button("Stop"));
    await click(button("Stop"));
    await key("Escape");
    expect($(".drawer-confirm")).toBeNull();
    expect(document.activeElement).toBe(button("Stop"));
    expect(onClose).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
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
    expect(document.activeElement).toBe($("aside.drawer"));
  });

  it("on invalid_state, says the item had ended and queries it again", async () => {
    const { bridge, query, set, replyWith } = fakeBridge([task]);
    await renderDrawer(bridge, task.id);
    set({ ...task, state: "done" } as ItemRecord);
    replyWith(async () => ({ ok: false, error: { code: "invalid_state", message: "already ended" } }));
    await click(button("Stop"));
    await click(button("Stop item"));
    expect(text('[role="status"]')).toBe("!The item had already ended. The drawer shows the item as it is now.");
    expect(query).toHaveBeenLastCalledWith({ type: "item", itemId: task.id });
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
    expect(text(".drawer-state")).toBe("●running · step 4 of 4 · Propose a fix");
  });

  it("queries the item again after the engine connection comes back", async () => {
    const { bridge, query, set, reconnect } = fakeBridge([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    // Missed while away: the engine moved the item on.
    set(approved);
    await reconnect();
    expect(query.mock.calls.filter(([q]) => q.type === "item")).toHaveLength(2);
    expect($(".needs-you")).toBeNull();
    expect(text(".drawer-state")).toBe("●running · step 4 of 4 · Propose a fix");
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
    expect(document.activeElement).toBe($("aside.drawer"));
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("closes on Esc and gives focus back to the row that opened it", async () => {
    const { row } = await openFromList();
    await key("Escape");
    expect($("aside.drawer")).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row.hasAttribute("aria-current")).toBe(false);
  });

  it("closes with the close button and gives focus back to the row", async () => {
    const { row } = await openFromList();
    await click(button("Close"));
    expect($("aside.drawer")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("closes when the engine connection fails, never showing ids without their setup", async () => {
    const { row, setConnection } = await openFromList();
    await setConnection({ status: "failed", reason: "engine exited", logPath: "/tmp/engine.log", logTail: [] });
    expect($("aside.drawer")).toBeNull();
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
    expect($$(".step-attempt").map((el) => el.textContent)).toEqual(["✕attempt 1 · failed · sh check.sh exit 1", "✓attempt 2 · passed · 1 check passed"]);
    expect(text(".drawer-state")).toContain("commit 3f2a9c1 on tokama/0b9f3c1e");
  });

  it("labels a decision by its kind and offers its own choices", async () => {
    const asked = {
      ...task,
      state: "needs_you",
      decision: { id: DECISION_ID, kind: "run_failure", stepIndex: 1, question: "The run failed. Retry the step, or stop?", why: "The agent call timed out.", choices: [{ id: "retry_step", label: "Retry step" }, { id: "stop", label: "Stop" }] },
    } as unknown as ItemRecord;
    const fake = fakeBridge([asked]);
    await renderDrawer(fake.bridge, asked.id);
    expect(text(".needs-you-kind")).toBe("Run failed");
    expect($$(".needs-you .choice").map((el) => el.textContent)).toEqual(["Retry step", "Stop"]);
    await act(async () => ($$(".needs-you .choice")[0] as HTMLButtonElement).click());
    expect(fake.command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: asked.id, decisionId: DECISION_ID, choice: "retry_step" });
  });
});

describe("item drawer: Finish", () => {
  const button = (label: string) => $$(".finish .choice, .finish-ended .link").find((el) => el.textContent === label) as HTMLButtonElement;
  const key = (name: string) => act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  const rows = () => $$(".finish-row").map((el) => [el.querySelector(".finish-title")?.textContent, el.querySelector(".choice")?.textContent, (el.querySelector(".choice") as HTMLButtonElement).disabled]);

  it("shows no Finish section for items that are not done or have no worktree", async () => {
    await renderDrawer(fakeBridge([committed]).bridge, committed.id);
    expect($(".finish")).toBeNull();
    await renderDrawer(fakeBridge([task]).bridge, task.id);
    expect($(".finish")).toBeNull();
  });

  it("offers the three rows under the item branch; Merge and Open PR send finish_item, with the push target shown first", async () => {
    const fake = fakeBridge([finishable]);
    await renderDrawer(fake.bridge, finishable.id);
    expect(text(".finish-head")).toBe("Finishtokama/0b9f3c1e · 1 commit ahead of main");
    expect(rows()).toEqual([
      ["Merge into main", "Merge into main", false],
      ["Open PR", "Open PR", false],
      ["Discard", "Discard…", false],
    ]);
    expect($$(".finish-row .finish-text")[1]?.textContent).toContain("to github.com/northwind/orders-api and opens a pull request with gh");
    await act(async () => button("Merge into main").click());
    expect(fake.command).toHaveBeenCalledWith({ type: "finish_item", itemId: finishable.id, action: "merge" });
    await fake.push({ ...finishable, finish: { ...finishable.finish!, running: "merge" } });
    expect(text(".finish-running")).toContain("Merging into main");
    expect(rows().every(([, , disabled]) => disabled)).toBe(true);
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
    await act(async () => button("Discard…").click());
    expect(text(".finish-confirm-title")).toBe("Discard this work?");
    expect(text(".finish-confirm .finish-text")).toBe("Deletes the worktree and the branch tokama/0b9f3c1e with its 1 commit. The item and its log stay. This can't be undone.");
    expect(fake.command).not.toHaveBeenCalled();
    await key("Escape");
    expect($(".finish-confirm")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("Discard…").click());
    await act(async () => ($$(".finish-confirm .choice").find((el) => el.textContent === "Keep") as HTMLButtonElement).click());
    expect(fake.command).not.toHaveBeenCalled();
    await act(async () => button("Discard…").click());
    await act(async () => ($$(".finish-confirm .choice").find((el) => el.textContent === "Discard") as HTMLButtonElement).click());
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
    expect(button("Open PR").disabled).toBe(true);
    expect(text(".finish-off")).toBe("✕ logged out · run gh auth login in a terminalCheck again");
    await act(async () => ($(".finish-off .link") as HTMLButtonElement).click());
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
    await act(async () => ($$(".finish-confirm .choice").find((el) => el.textContent === "Discard") as HTMLButtonElement).click());
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
    expect([...wrap.querySelectorAll("[role=menuitem]")].map((el) => el.textContent)).toEqual(["Merge into mainlocal merge, then clean up", "Open PRpush and open with gh", "Discard…"]);
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
    await act(async () => ($$(".finish .choice").find((el) => el.textContent === "Discard…") as HTMLButtonElement).click());
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
    await act(async () => ($$(".finish-confirm .choice").find((el) => el.textContent === "Keep") as HTMLButtonElement).click());
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
    expect($("aside.drawer h2")?.textContent).toBe(finishable.title);
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
    const accept = $$(".finish-row .choice").find((el) => el.textContent === "I made this change") as HTMLButtonElement;
    expect(accept.closest(".finish-row")?.getAttribute("data-action")).toBe("merge");
    await act(async () => accept.click());
    expect(fake.command).toHaveBeenCalledWith({ type: "accept_git_changes", itemId: refused.id });
  });
});
