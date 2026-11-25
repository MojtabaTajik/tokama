// @vitest-environment happy-dom
import type { ItemRecord, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { App } from "../App.js";
import { approved, committed, DECISION_ID, needsYou, setup, task } from "../testing/drawer.js";
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

  it("adds Diff and Checks for a task, and Open worktree, disabled", async () => {
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
    expect($$(".drawer-actions button").map((el) => [el.textContent, el.getAttribute("aria-disabled")])).toEqual([
      ["Open worktree", "true"],
      ["Add a hint", "true"],
      ["Stop", null],
    ]);
  });

  it("shows no Open worktree for an investigation and no Stop once the item has ended", async () => {
    const { bridge, push } = fakeBridge([needsYou]);
    await renderDrawer(bridge, needsYou.id);
    expect($$(".drawer-actions button").map((el) => el.textContent)).toEqual(["Add a hint", "Stop"]);
    await push({ ...approved, state: "done" } as ItemRecord);
    expect($$(".drawer-actions button").map((el) => el.textContent)).toEqual(["Add a hint"]);
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
    state: "needs_you",
    decision: {
      id: DIFF_DECISION,
      kind: "plan_approval",
      stepIndex: 0,
      question: "Approve this step's result?",
      hasDiff: true,
      choices: [
        { id: "approve", label: "Approve" },
        { id: "request_changes", label: "Request changes" },
        { id: "stop", label: "Stop" },
      ],
    },
  } as unknown as ItemRecord;
  const diff = {
    files: [
      { path: "src/a.ts", status: "modified", added: 1, removed: 1, binary: false, cut: false, hunks: [{ header: "@@ -1 +1 @@", lines: ['-<img src=x onerror="alert(1)">', "+<b>bold</b>"] }] },
      { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", added: 0, removed: 0, binary: false, cut: false, hunks: [] },
      { path: "logo.png", status: "added", added: null, removed: null, binary: true, cut: false, hunks: [] },
    ],
    moreFiles: 2,
    cut: true,
    worktree: { repoId: "orders-api", dir: ".tokama/wt/abc", branch: "tokama/abc" },
  };
  const withDiff = (reply: Reply) => {
    const fake = fakeBridge([waiting]);
    const base = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q: { type: string; itemId?: string }) => (q.type === "decision_diff" ? reply : base(q)));
    return fake;
  };

  it("shows the changed files with their counts and the hunks as text, and says what is left out", async () => {
    const { bridge, query } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    expect(query).toHaveBeenCalledWith({ type: "decision_diff", itemId: waiting.id, decisionId: DIFF_DECISION });
    expect($$(".decision-diff-files li").map((el) => el.textContent)).toEqual([
      "modified src/a.ts +1 −1",
      "renamed src/old.ts → src/new.ts +0 −0",
      "added logo.png binary",
      "2 more files not listed",
    ]);
    expect(text(".decision-diff-text")).toBe('── src/a.ts\n@@ -1 +1 @@\n-<img src=x onerror="alert(1)">\n+<b>bold</b>');
    expect($(".decision-diff-text")?.children.length).toBe(0);
    expect($$(".drawer img, .drawer b")).toEqual([]);
    expect(text(".decision-diff .needs-you-why")).toContain("Open the worktree in your editor to see all of it: orders-api/.tokama/wt/abc (branch tokama/abc).");
  });

  it("says when the change cannot be loaded", async () => {
    const { bridge } = withDiff({ ok: false, error: { code: "stale_decision", message: "Decision is not open." } });
    await renderDrawer(bridge, waiting.id);
    expect(text(".decision-diff .drawer-error")).toBe("✕Could not load the change: Decision is not open.");
  });

  it("Request changes asks for a note and sends it with the answer; Cancel goes back to the buttons", async () => {
    const { bridge, command } = withDiff({ ok: true, data: diff });
    await renderDrawer(bridge, waiting.id);
    await click(button("Request changes"));
    expect(command).not.toHaveBeenCalled();
    await click(button("Cancel"));
    await click(button("Request changes"));
    const note = $(".decision-note-text") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "  Keep the old name.  ");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Send and run again"));
    expect(command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: waiting.id, decisionId: DIFF_DECISION, choice: "request_changes", note: "Keep the old name." });
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
