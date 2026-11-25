// @vitest-environment happy-dom
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokamaBridge } from "../../shared/bridge.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
import { ITEMS, items, NOW } from "../testing/sample.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const MINUTE = 60_000;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const render = (bridge: TokamaBridge) => act(async () => root.render(<App bridge={bridge} retryDelayMs={10} now={NOW} />));
const railButton = (label: RegExp) => $$(".rail button").find((button) => label.test(button.getAttribute("aria-label") ?? ""))!;
const openPage = () => click(railButton(/^Needs you/));
const rowTitles = () => $$(".nr-title").map((el) => el.textContent);
const choiceButtons = (row: Element) => [...row.querySelectorAll(".choices .btn:not(.btn-link)")] as HTMLButtonElement[];

const DECISION = ITEMS.needsYou.decision!;
/** The sample item, with the step's data rule that makes the question a cloud-step approval. */
const cloud = { ...ITEMS.needsYou, steps: ITEMS.needsYou.steps.map((step, index) => (index === 2 ? { ...step, data: "summary-after-approval" } : step)) } as ItemRecord;
/** An older item that waits on a decision about a local step, with two choices of its own. */
const older: ItemRecord = {
  ...ITEMS.needsYou,
  id: "item_1a2b3c4d-0099-4a1b-8c1d-000000000099",
  title: "Plan is ready <b>for review</b>",
  templateId: "builtin/plan-and-build",
  kind: "task",
  createdAt: NOW - 70 * MINUTE,
  decision: { id: "decision_aaaaaaaa-0000-4000-8000-000000000001", stepIndex: 0, question: "Approve the plan?", choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  steps: [
    { name: "Plan", stage: "working", state: "needs_you", agentId: "architect", data: "none" },
    { name: "Build", stage: "working", state: "pending", agentId: "local-builder", data: "none" },
  ],
} as unknown as ItemRecord;
const withOlder = [...items.filter((item) => item !== ITEMS.needsYou), cloud, older];
const withoutWaiting = items.filter((item) => item.state !== "needs_you");

describe("the Needs you page", () => {
  it("opens from the rail, marks it as the current page and leads back to the board", async () => {
    await render(fakeBridge(CONNECTED, { boardItems: withOlder }).bridge);
    expect(railButton(/^Needs you/).getAttribute("aria-label")).toBe("Needs you · 2");
    expect(railButton(/^Needs you/).hasAttribute("aria-disabled")).toBe(false);
    await openPage();
    expect(text("main h1")).toBe("Needs you");
    expect(railButton(/^Needs you/).getAttribute("aria-current")).toBe("page");
    expect(railButton(/^Board$/).hasAttribute("aria-current")).toBe(false);
    expect($(".pl-row")).toBeNull();
    await click(railButton(/^Board$/));
    expect(text("main h1")).toBe("All work");
    expect(railButton(/^Needs you/).hasAttribute("aria-current")).toBe(false);
  });

  it("lists every decision, oldest first, with the count and the oldest age", async () => {
    await render(fakeBridge(CONNECTED, { boardItems: withOlder }).bridge);
    await openPage();
    expect(rowTitles()).toEqual(["Plan is ready <b>for review</b>", "Orders API returns 500 after deploy"]);
    expect(text(".summary")).toBe("2 waiting · oldest item started 1 h 10 m ago");
    expect($(".nr-row b")).toBeNull();
  });

  it("shows the kind, workflow, step, agent, age, question and choices of a row", async () => {
    await render(fakeBridge(CONNECTED, { boardItems: withOlder }).bridge);
    await openPage();
    const [plan, cloudRow] = $$(".nr-row");
    expect(plan?.querySelector(".nr-kind")?.textContent).toBe("⏸ Decision");
    expect(plan?.querySelector(".nr-workflow")?.textContent).toBe("Plan and build");
    expect(plan?.querySelector(".nr-where")?.textContent).toBe("step 1 of 2 · PlanArchitectClaude Code");
    expect(plan?.querySelector(".nr-time")?.textContent).toBe("started 1 h 10 m ago");
    expect(plan?.querySelector(".nr-question")?.textContent).toBe("Approve the plan?");
    expect(choiceButtons(plan!).map((button) => button.textContent)).toEqual(["Yes", "No"]);
    expect(choiceButtons(plan!)[0]?.className).toBe("btn btn-primary");
    expect(cloudRow?.querySelector(".nr-kind")?.textContent).toBe("⏸ Cloud-step approval");
    expect(cloudRow?.querySelector(".nr-time")?.textContent).toBe("started 41 m ago");
    expect(cloudRow?.querySelector(".nr-question")?.textContent).toBe(DECISION.question);
    expect(choiceButtons(cloudRow!).map((button) => button.getAttribute("aria-label"))).toEqual(["Approve and send: Orders API returns 500 after deploy"]);
  });

  it("answers inline with the drawer's command, then drops the row, the badge and shows the empty state", async () => {
    const fake = fakeBridge(CONNECTED, { boardItems: items, commandReply: () => ({ ok: true, data: null }) });
    await render(fake.bridge);
    await openPage();
    const button = choiceButtons($(".nr-row")!)[0]!;
    button.focus();
    await click(button);
    expect(fake.command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: ITEMS.needsYou.id, decisionId: DECISION.id, choice: "approve" });
    await fake.pushItem({ ...ITEMS.needsYou, state: "running", decision: undefined } as ItemRecord);
    expect($(".nr-row")).toBeNull();
    expect(text(".empty-state-title")).toBe("Nothing is waiting for you");
    expect(text(".summary")).toBe("0 waiting");
    expect($(".badge")).toBeNull();
    // Focus lands on the page, not on the document.
    expect(document.activeElement).toBe($("main"));
  });

  it("moves focus to the next row when an answered row goes", async () => {
    const fake = fakeBridge(CONNECTED, { boardItems: withOlder, commandReply: () => ({ ok: true, data: null }) });
    await render(fake.bridge);
    await openPage();
    const first = choiceButtons($$(".nr-row")[0]!)[0]!;
    first.focus();
    await click(first);
    await fake.pushItem({ ...older, state: "running", decision: undefined } as ItemRecord);
    expect(document.activeElement).toBe($(".nr-title"));
    expect(document.activeElement?.textContent).toBe("Orders API returns 500 after deploy");
  });

  it("disables the row's buttons while its answer is in flight, and only that row's", async () => {
    let release: (() => void) | undefined;
    const fake = fakeBridge(CONNECTED, { boardItems: withOlder });
    (fake.bridge.command as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((resolve) => (release = () => resolve({ ok: true, data: null }))));
    await render(fake.bridge);
    await openPage();
    const [plan, cloudRow] = $$(".nr-row");
    await click(choiceButtons(plan!)[1]!);
    expect(choiceButtons(plan!).every((button) => button.disabled)).toBe(true);
    expect(choiceButtons(cloudRow!).some((button) => button.disabled)).toBe(false);
    await act(async () => release?.());
    expect(choiceButtons(plan!).some((button) => button.disabled)).toBe(false);
  });

  it("says in the row, with a symbol, when the engine refuses the answer, and loads again after a stale question", async () => {
    const fake = fakeBridge(CONNECTED, { boardItems: items, commandReply: () => ({ ok: false, error: { code: "stale_decision", message: "the question changed" } }) });
    await render(fake.bridge);
    await openPage();
    const boards = () => fake.query.mock.calls.filter(([q]) => q.type === "board").length;
    const before = boards();
    await click(choiceButtons($(".nr-row")!)[0]!);
    await wait(10);
    expect(text(".nr-row .drawer-notice")).toBe("!The question changed before your answer reached the engine. The drawer shows the item as it is now.");
    expect(boards()).toBe(before + 1);
    expect($(".nr-row")).not.toBeNull();

    fake.command.mockResolvedValueOnce({ ok: false, error: { code: "invalid_choice", message: "no such choice" } });
    await click(choiceButtons($(".nr-row")!)[0]!);
    expect(text(".nr-row .drawer-notice")).toBe("✕The engine did not accept that choice: no such choice");
  });

  it("selects a row by its title or its free space, which opens the drawer; the choices do not", async () => {
    const fake = fakeBridge(CONNECTED, { boardItems: withOlder, commandReply: () => ({ ok: true, data: null }) });
    await render(fake.bridge);
    await openPage();
    expect($(".drawer")).toBeNull();
    await click($$(".nr-title")[1]!);
    expect($(".drawer h2")?.textContent).toBe("Orders API returns 500 after deploy");
    expect($$(".nr-row")[1]?.getAttribute("aria-current")).toBe("true");
    expect($$(".nr-title")[1]?.getAttribute("aria-current")).toBe("true");
    await click($$(".nr-row")[0]!.querySelector(".nr-question"));
    expect($(".drawer h2")?.textContent).toBe(older.title);
    await click(choiceButtons($$(".nr-row")[1]!)[0]!);
    expect($(".drawer h2")?.textContent).toBe(older.title);
  });

  it("a change approval row lists the changed files, answers with Approve and commit or a note, and Review the diff opens the drawer on its Diff tab", async () => {
    const change = {
      ...older,
      id: "item_1a2b3c4d-0098-4a1b-8c1d-000000000098",
      title: "Show tax on the receipt total",
      templateId: "builtin/quick-change",
      decision: {
        id: "decision_aaaaaaaa-0000-4000-8000-0000000000c1",
        kind: "plan_approval",
        stepIndex: 0,
        question: "Approve this change and commit it?",
        hasDiff: true,
        choices: [
          { id: "approve", label: "Approve and commit" },
          { id: "request_changes", label: "Request changes" },
          { id: "stop", label: "Stop" },
        ],
      },
      steps: [{ name: "Change", stage: "review", state: "needs_you", agentId: "local-builder", data: "none", runs: 1, maxAttempts: 3, attempts: [{ attempt: 1, result: "passed", checks: [] }] }],
    } as unknown as ItemRecord;
    const file = (path: string, extra: Record<string, unknown> = {}) => ({ path, status: "modified", added: 10, removed: 2, binary: false, cut: false, hunks: [{ header: "@@ -1 +1 @@", lines: ["-a", "+b"] }], ...extra });
    const diff = {
      files: [file("src/receipt/format.js"), file("assets/logo.png", { added: null, removed: null, binary: true, cut: true, hunks: [] }), file("package-lock.json", { added: 1220, removed: 313, cut: true, hunks: [] })],
      moreFiles: 0,
      cut: true,
      worktree: { repoId: "orders-api", dir: ".tokama/wt/abc", branch: "tokama/abc", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" },
    };
    const fake = fakeBridge(CONNECTED, {
      boardItems: [...withoutWaiting, change],
      reply: (q) => (q.type === "decision_diff" ? { ok: true, data: diff } : q.type === "item" && (q as { itemId?: string }).itemId === change.id ? { ok: true, data: { item: change } } : undefined),
      commandReply: () => ({ ok: true, data: null }),
    });
    await render(fake.bridge);
    await openPage();
    const row = $(".nr-row")!;
    expect(text(".nr-kind")).toContain("Change approval");
    expect(text(".nr-where")).toContain("step 1 of 1 · Change · you approve");
    expect(text(".dv-changed-head")).toBe("Changed3 files · nothing committed yet");
    expect($$(".dv-changed-list li").map((el) => el.textContent)).toEqual(["src/receipt/format.js+10−2", "assets/logo.png · package-lock.jsonbinary · too large"]);
    expect(choiceButtons(row).map((el) => el.textContent)).toEqual(["Approve and commit", "Request changes"]);
    await click(choiceButtons(row)[1]);
    expect(text(".decision-note-hint")).toBe("Goes into Local builder's next run with the current diff. Run 2 of 3.");
    await click($$("button").find((el) => el.textContent === "Cancel"));
    await click($(".nr-review"));
    await wait(20);
    expect($('.drawer [role="tab"][aria-selected="true"]')?.textContent).toBe("Diff");
    // With the drawer already on the item, on another tab, Review the diff shows the Diff tab again.
    await click($$('.drawer [role="tab"]').find((el) => el.textContent === "Steps"));
    await click($(".nr-review"));
    expect($('.drawer [role="tab"][aria-selected="true"]')?.textContent).toBe("Diff");
    await click(choiceButtons(row)[0]);
    expect(fake.command).toHaveBeenCalledWith({ type: "resolve_decision", itemId: change.id, decisionId: change.decision!.id, choice: "approve" });
  });

  it("a plan approval row previews the first lines of the plan as text, and Read the plan opens the drawer with the whole plan", async () => {
    const plan = {
      ...older,
      id: "item_1a2b3c4d-0097-4a1b-8c1d-000000000097",
      title: "Reserve stock when an order is placed",
      decision: {
        id: "decision_aaaaaaaa-0000-4000-8000-0000000000e1",
        kind: "plan_approval",
        stepIndex: 0,
        question: "Approve this step's result?",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "request_changes", label: "Request changes" },
        ],
      },
      steps: [{ ...older.steps[0]!, attempts: [{ attempt: 1, result: "passed", checks: [] }] }, older.steps[1]!],
    } as unknown as ItemRecord;
    const text5 = "## Plan <b>now</b>\n\n- Add a table\n- Call it at checkout\n- Release it on cancel\n- Test it";
    const fake = fakeBridge(CONNECTED, {
      boardItems: [...withoutWaiting, plan],
      reply: (q) =>
        q.type === "step_output" ? { ok: true, data: { attempt: 1, text: text5, truncated: false } } : q.type === "item" && (q as { itemId?: string }).itemId === plan.id ? { ok: true, data: { item: plan } } : undefined,
    });
    await render(fake.bridge);
    await openPage();
    await wait(0);
    expect(text(".nr-preview")).toBe("Plan <b>now</b>\nAdd a table\nCall it at checkout");
    expect($$(".nr-row b")).toEqual([]);
    const read = $(".nr-read") as HTMLButtonElement;
    expect(read.textContent).toBe("Read the plan");
    expect(read.getAttribute("aria-label")).toBe("Read the plan: Reserve stock when an order is placed");
    expect($(".drawer")).toBeNull();
    await click(read);
    await wait(10);
    expect($(".drawer h2")?.textContent).toBe(plan.title);
    expect($$(".drawer .step-output-preview li").map((el) => el.textContent)).toEqual(["Add a table", "Call it at checkout", "Release it on cancel", "Test it"]);
  });

  it("shows an item that waits without a question as text only, with no buttons", async () => {
    const bare = { ...ITEMS.needsYou, decision: undefined } as ItemRecord;
    await render(fakeBridge(CONNECTED, { boardItems: [bare] }).bridge);
    await openPage();
    expect(text(".nr-question")).toBe("This item waits for you, but the engine sent no question yet.");
    expect($(".choices")).toBeNull();
  });

  it("shows the exact text of a cloud summary as text", async () => {
    const summary = "Send <i>this</i> only";
    const item = { ...ITEMS.needsYou, decision: { ...DECISION, summaryText: summary } } as ItemRecord;
    await render(fakeBridge(CONNECTED, { boardItems: [item] }).bridge);
    await openPage();
    expect(text(".cloud-summary-text")).toBe(summary);
    expect($(".cloud-summary-text i")).toBeNull();
    expect(text(".cloud-summary-label")).toBe("Will be sentNothing has been sent yet");
  });

  it("shows an empty state, not a list, when nothing waits", async () => {
    await render(fakeBridge(CONNECTED, { boardItems: withoutWaiting }).bridge);
    await openPage();
    expect(text(".empty-state-title")).toBe("Nothing is waiting for you");
    expect($(".nr-list")).toBeNull();
  });

  it("does not claim all clear while the items are from a failed load", async () => {
    let failing = false;
    const fake = fakeBridge(CONNECTED, { boardItems: withoutWaiting, reply: (q) => (failing && q.type === "setup" ? { ok: false, error: { code: "timeout", message: "no answer" } } : undefined) });
    await render(fake.bridge);
    await openPage();
    expect($(".empty-state-title")).not.toBeNull();
    failing = true;
    await fake.setConnection({ status: "reconnecting" });
    await fake.setConnection({ status: "connected", engineId: "e-1" });
    await wait(40);
    expect($(".empty-state-title")).toBeNull();
    expect(text(".failure-title")).toBe("✕Could not refresh the list. It may be out of date");
    failing = false;
    await click($$("button").find((button) => button.textContent === "Retry"));
    expect($(".failure")).toBeNull();
    expect($(".empty-state-title")).not.toBeNull();
  });

  it("shows why the engine is not available instead of a list", async () => {
    const fake = fakeBridge({ status: "failed", reason: "no_node", logPath: "/tmp/engine.log", logTail: [] }, { boardItems: items });
    await render(fake.bridge);
    await openPage();
    expect($(".nr-list")).toBeNull();
    expect($(".empty-state-title")).toBeNull();
    expect($(".board .failure, .board .retry")).not.toBeNull();
    expect($(".summary")).toBeNull();
  });

  it("keeps New work working from the page, and returns to the board when it starts an item", async () => {
    const started = { ...ITEMS.queued, id: "item_1a2b3c4d-0098-4a1b-8c1d-000000000098", title: "Fix the retry loop", templateId: "builtin/quick-fix", repoIds: ["orders-api"] } as ItemRecord;
    const fake = fakeBridge(CONNECTED, {
      boardItems: items,
      reply: (q) => ((q as { itemId?: string }).itemId === started.id ? { ok: true, data: { item: started } } : undefined),
      commandReply: () => ({ ok: true, data: { itemId: started.id } }),
    });
    await render(fake.bridge);
    await openPage();
    await click($(".new-work"));
    expect($(".np-body")).not.toBeNull();
    const trigger = (label: string) => $$(".np-trigger").find((el) => el.querySelector(".np-trigger-label")?.textContent === label)!;
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix")));
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    await act(async () => {
      const field = $(".np-text") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Fix the retry loop");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click($(".np-start"));
    expect(fake.command).toHaveBeenCalledWith(expect.objectContaining({ type: "start_item", templateId: "builtin/quick-fix", text: "Fix the retry loop" }));
    await wait(0);
    expect(text("main h1")).toBe("All work");
    expect($(".drawer h2")?.textContent).toBe("Fix the retry loop");
  });

  it("leaves the page when a sidebar view is chosen, and closes it when About opens", async () => {
    await render(fakeBridge(CONNECTED, { boardItems: items }).bridge);
    await openPage();
    await click($$(".sb-main").find((el) => el.textContent?.startsWith("Quick fix")));
    expect(text("main h1")).toBe("Quick fix");
    await openPage();
    await click(railButton(/^About/));
    expect(text("main h1")).toBe("About");
    expect(railButton(/^Needs you/).hasAttribute("aria-current")).toBe(false);
    await openPage();
    expect(text("main h1")).toBe("Needs you");
    expect($(".about")).toBeNull();
  });
});
