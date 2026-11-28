// @vitest-environment happy-dom
import type { ItemRecord, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenResult, TokamaBridge } from "../../shared/bridge.js";
import { setup as baseSetup, task } from "../testing/drawer.js";
import { resetOpenSections } from "../ui/Section.js";
import { ItemDrawer } from "./ItemDrawer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

const TEMPLATE = {
  id: "builtin/quick-fix",
  name: "Quick fix",
  kind: "task",
  connections: [],
  steps: [{ name: "Build", stage: "working", agentId: "local-builder", data: "none", checks: { from: "repo" } }],
  start: { needs: ["text", "repo"], askBeforeCloud: false },
  warnings: [],
};
const setup = { ...baseSetup, templates: [...baseSetup.templates, TEMPLATE] } as unknown as Setup;

/** A Quick fix whose Build failed its checks once and runs again. */
const built = {
  ...task,
  id: "item_1a2b3c4d-0020-4a1b-8c1d-000000000020",
  templateId: "builtin/quick-fix",
  title: "Paginate the orders list",
  steps: [
    {
      name: "Build",
      stage: "working",
      state: "running",
      agentId: "local-builder",
      data: "none",
      runs: 2,
      maxAttempts: 3,
      attempts: [
        { attempt: 1, result: "failed", checks: [{ command: "pnpm test", passed: false, exitCode: 1 }, { command: "pnpm lint", passed: true, exitCode: 0 }] },
        { attempt: 2, checks: [] },
      ],
    },
  ],
} as unknown as ItemRecord;

/** A Plan, Build and Review item, the Build with three attempts, and the Review not run. */
const threeSteps = {
  ...task,
  id: "item_1a2b3c4d-0021-4a1b-8c1d-000000000021",
  templateId: "builtin/quick-fix",
  title: "Export orders as CSV",
  state: "failed",
  steps: [
    { name: "Plan", stage: "working", state: "passed", agentId: "architect", data: "none", attempts: [{ attempt: 1, result: "passed", startedAt: 1_000, durationMs: 372_000, transcriptSaved: true, transcriptBytes: 22_528, checks: [] }] },
    {
      name: "Build",
      stage: "working",
      state: "failed",
      agentId: "local-builder",
      data: "none",
      attempts: [
        { attempt: 1, result: "failed", startedAt: 2_000, durationMs: 91_000, transcriptSaved: true, transcriptBytes: 14_336, checks: [{ command: "pnpm test", passed: false, exitCode: 1 }] },
        { attempt: 2, result: "failed", startedAt: 3_000, durationMs: 82_000, transcriptSaved: false, checks: [{ command: "pnpm test", passed: false, exitCode: 1 }] },
        { attempt: 3, result: "failed", startedAt: 4_000, durationMs: 79_000, transcriptSaved: true, transcriptBytes: 12_288, checks: [{ command: "pnpm test", passed: false, exitCode: 1 }] },
      ],
    },
    { name: "Review", stage: "review", state: "pending", agentId: "reviewer", data: "none" },
  ],
} as unknown as ItemRecord;

const FAIL_OUTPUT = ' FAIL  src/orders/list.test.ts\n<script>alert(1)</script>\n2 failing · 416 passed';
const CHECKS: Record<number, unknown> = {
  1: {
    attempt: 1,
    checks: [
      { command: "pnpm test", state: "failed", exitCode: 1, durationMs: 112_000, summary: "2 failing · 416 passed", output: { text: FAIL_OUTPUT, truncated: true, totalBytes: 98_304, totalLines: 1312 } },
      { command: "pnpm lint", state: "passed", exitCode: 0, durationMs: null, summary: "No problems found.", output: { text: "> eslint .\n\nNo problems found.", truncated: false, totalBytes: 30, totalLines: 3 } },
    ],
  },
  2: {
    attempt: 2,
    checks: [
      { command: "pnpm test", state: "waiting", exitCode: null, durationMs: null, summary: "", output: null },
      { command: "pnpm lint", state: "waiting", exitCode: null, durationMs: null, summary: "", output: null },
    ],
  },
};
const LOGS: Record<number, unknown> = {
  1: {
    attempt: 1,
    transcript: { text: "I'll follow the plan.\n\n→ Read src/orders/list.ts\n→ Edit src/orders/list.ts\n\nDone <script>x</script>", truncated: true, totalBytes: 217_088, totalLines: 1180 },
    final: { text: "Done. GET /orders takes ?cursor=.", truncated: false },
  },
  2: { attempt: 2, transcript: { text: "", truncated: false, totalBytes: 0, totalLines: 0 }, final: null },
  3: { attempt: 3, transcript: { text: "Third try.", truncated: false, totalBytes: 10, totalLines: 1 }, final: null },
};

function fakeBridge(items: ItemRecord[], replies: { checks?: Record<number, unknown>; logs?: Record<number, unknown> } = {}, open: () => Promise<OpenResult> = async () => ({ ok: true })) {
  const query = vi.fn(async (q: { type: string; itemId?: string; attempt?: number }): Promise<Reply> => {
    if (q.type === "item") {
      const item = items.find((candidate) => candidate.id === q.itemId);
      return item ? { ok: true, data: { item } } : { ok: false, error: { code: "not_found", message: "gone" } };
    }
    const table = q.type === "attempt_checks" ? (replies.checks ?? CHECKS) : q.type === "attempt_log" ? (replies.logs ?? LOGS) : undefined;
    const data = table?.[q.attempt ?? 0];
    if (data !== undefined) return { ok: true, data };
    return { ok: false, error: { code: "not_found", message: `nothing for ${q.type}` } };
  });
  const openAttemptFile = vi.fn(open);
  const bridge = {
    query,
    command: vi.fn(),
    openAttemptFile,
    onEvent: vi.fn(() => () => undefined),
    onConnection: vi.fn(() => () => undefined),
  } as unknown as TokamaBridge;
  return { bridge, query, openAttemptFile };
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  resetOpenSections();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent ?? "";
const click = (element: Element | undefined) => act(async () => (element as HTMLElement).click());
const tab = (name: string) => $$('[role="tab"]').find((el) => el.textContent === name);
const asked = (query: { mock: { calls: unknown[][] } }, type: string) => query.mock.calls.map(([q]) => q as { type: string; attempt?: number }).filter((q) => q.type === type);

async function open(bridge: TokamaBridge, item: ItemRecord, name: string, options: { full?: boolean; setupData?: Setup } = {}) {
  const expanded = options.full === true ? { back: "All work", wide: true, onCollapse: vi.fn(), onShowAll: vi.fn() } : undefined;
  await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={item.id} setup={options.setupData ?? setup} onClose={vi.fn()} expanded={expanded} />));
  await click(tab(name));
}

/** The folded lines of a tab (not the ones inside them): their button or plain line. */
const lines = (scope: string) => $$(`${scope} > .sec-wrap > .sec-list > .sec > .sec-h > .sec-head`);
const summary = (line: Element) => line.closest(".sec")?.querySelector(":scope > .sec-sum")?.textContent;
const stateOf = (line: Element) => line.querySelector(".sec-state")?.textContent;

describe("Checks tab", () => {
  it("folds each attempt to a line, oldest first; the newest opens, its commands waiting as plain lines, and only it is asked for", async () => {
    const { bridge, query } = fakeBridge([built]);
    await open(bridge, built, "Checks");
    const attempts = lines(".ck");
    expect(attempts.map((line) => [line.querySelector(".sec-name")?.textContent, stateOf(line), line.getAttribute("aria-expanded")])).toEqual([
      ["Attempt 1", "✕failed · 1 of 2 checks failed", "false"],
      ["Attempt 2 · fresh session", "●running", "true"],
    ]);
    expect(asked(query, "attempt_checks").map((q) => q.attempt)).toEqual([2]);
    const rows = $$(".ck-check");
    expect(rows.map((row) => [row.getAttribute("data-state"), row.querySelector(".sec-name")?.textContent, stateOf(row), row.querySelector(".sec-head")?.tagName, summary(row.querySelector(".sec-head")!)])).toEqual([
      ["waiting", "$ pnpm test", "○waiting", "DIV", "runs when Build ends"],
      ["waiting", "$ pnpm lint", "○waiting", "DIV", "runs when Build ends"],
    ]);
  });

  it("opens an attempt on its line: a failed command opens with its output, a passed one starts folded", async () => {
    const { bridge, query } = fakeBridge([built]);
    await open(bridge, built, "Checks");
    await click(lines(".ck")[0]);
    expect(asked(query, "attempt_checks").map((q) => q.attempt)).toEqual([2, 1]);
    const rows = $$(".ck-check").filter((row) => row.closest(".sec")?.querySelector(".sec-name")?.textContent === "Attempt 1" || row.getAttribute("data-state") !== "waiting");
    expect(rows.map((row) => [row.getAttribute("data-state"), row.querySelector(".sec-name")?.textContent, stateOf(row), row.querySelector(".sec-facts")?.textContent, row.querySelector(".sec-head")?.getAttribute("aria-expanded")])).toEqual([
      ["failed", "$ pnpm test", "✕failed", "exit 1 · 1 m 52 s", "true"],
      ["passed", "$ pnpm lint", "✓passed", "exit 0", "false"],
    ]);
    // The passed command's summary shows under its folded line.
    expect(summary($$(".ck-check[data-state='passed'] .sec-head")[0]!)).toBe("No problems found.");
  });

  it("shows the output as text only, with the cap note and Open the file for the rest", async () => {
    const { bridge, openAttemptFile } = fakeBridge([built], {}, async () => ({ ok: false, message: "Tokama does not open check-1.log: it is a link." }));
    await open(bridge, built, "Checks");
    await click(lines(".ck")[0]);
    const failed = $(".ck-check[data-state='failed']")!;
    expect(failed.querySelector(".ck-lines")?.textContent).toBe(FAIL_OUTPUT);
    expect(container.querySelector("script")).toBeNull();
    expect(failed.querySelector(".ck-cap")?.textContent).toBe("Last 3 of 1,312 lines · 96 KB");
    // The passed check is folded: its complete output has no cap note and no button.
    expect($(".ck-check[data-state='passed'] .open-file")).toBeNull();
    await click(failed.querySelector(".open-file")!);
    expect(openAttemptFile).toHaveBeenCalledWith({ itemId: built.id, stepIndex: 0, attempt: 1, file: 1 });
    expect(failed.querySelector(".open-file-problem")?.textContent).toBe("!Could not open it: Tokama does not open check-1.log: it is a link.");
  });

  it("makes an attempt that ran no checks a line with no arrow that names the commands and says why", async () => {
    const stopped = { ...built, steps: [{ ...built.steps[0]!, state: "failed", attempts: [{ attempt: 1, result: "run_failed", detail: "The check could not run. `pnpm test` was refused by the command policy.", checks: [] }] }] } as unknown as ItemRecord;
    const { bridge, query } = fakeBridge([stopped]);
    await open(bridge, stopped, "Checks");
    const [line] = lines(".ck");
    expect(line?.tagName).toBe("DIV");
    expect(line?.querySelector(".sec-name")?.textContent).toBe("Attempt 1");
    expect(stateOf(line!)).toBe("!run failed");
    expect(line?.querySelector(".sec-facts")?.textContent).toBe("pnpm test");
    expect(summary(line!)).toBe("The check could not run. `pnpm test` was refused by the command policy.");
    expect(asked(query, "attempt_checks")).toEqual([]);
  });

  it("links the sandbox help page in the reason an attempt did not run", async () => {
    const page = "https://tokama.dev/docs/linux-sandbox";
    const detail = `Claude Code could not start its sandbox: x. How to allow it: ${page} Then check again.`;
    const stopped = { ...built, steps: [{ ...built.steps[0]!, state: "failed", attempts: [{ attempt: 1, result: "run_failed", detail, checks: [] }] }] } as unknown as ItemRecord;
    const { bridge } = fakeBridge([stopped]);
    await open(bridge, stopped, "Checks");
    expect([...lines(".ck")[0]!.closest(".sec")!.querySelectorAll(":scope > .sec-sum a")].map((a) => a.getAttribute("href"))).toEqual([page]);
  });

  it("says when a command did not run or its output was not saved", async () => {
    const refused = { ...built, steps: [{ ...built.steps[0]!, state: "failed", attempts: [{ attempt: 1, result: "run_failed", detail: "The check could not run. `pnpm lint` was refused by the command policy.", checks: [{ command: "pnpm test", passed: true, exitCode: 0 }] }] }] } as unknown as ItemRecord;
    const withRow = fakeBridge([refused], {
      checks: { 1: { attempt: 1, checks: [{ command: "pnpm test", state: "passed", exitCode: 0, durationMs: 1000, summary: "", output: null }, { command: "pnpm lint", state: "not_run", exitCode: null, durationMs: null, summary: "The check could not run. `pnpm lint` was refused by the command policy.", output: null }] } },
    });
    await open(withRow.bridge, refused, "Checks");
    const notRun = $(".ck-check[data-state='not_run']")!;
    expect([stateOf(notRun), notRun.querySelector(".sec-facts")?.textContent, summary(notRun.querySelector(".sec-head")!)]).toEqual(["!did not run", undefined, "The check could not run. `pnpm lint` was refused by the command policy."]);

    const lost = fakeBridge([built], { checks: { ...CHECKS, 1: { attempt: 1, checks: [{ command: "pnpm test", state: "failed", exitCode: 1, durationMs: null, summary: "", output: null }] } } });
    await open(lost.bridge, built, "Checks");
    await click(lines(".ck")[0]);
    expect(text(".ck-out-none")).toBe("The output of this check was not saved.");
  });

  it("opens a failed command by itself when it turns failed, until the engineer chooses", async () => {
    const running = { ...built, steps: [{ ...built.steps[0]!, attempts: [{ attempt: 1, checks: [] }] }] } as unknown as ItemRecord;
    const asRunning = { attempt: 1, checks: [{ command: "pnpm test", state: "running", exitCode: null, durationMs: null, summary: "", output: { text: "…", truncated: false, totalBytes: 1, totalLines: 1 } }] };
    const asFailed = { attempt: 1, checks: [{ command: "pnpm test", state: "failed", exitCode: 1, durationMs: 5000, summary: "1 failing", output: { text: "1 failing", truncated: false, totalBytes: 9, totalLines: 1 } }] };
    vi.useFakeTimers();
    let now: unknown = asRunning;
    const { bridge } = fakeBridge([running], { checks: new Proxy({}, { get: () => now }) as Record<number, unknown> });
    await open(bridge, running, "Checks");
    expect($(".ck-check .sec-head")?.getAttribute("aria-expanded")).toBe("false");
    now = asFailed;
    await act(async () => vi.advanceTimersByTime(2000));
    expect($(".ck-check .sec-head")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("has an empty text before any attempt, and says so when no step runs checks", async () => {
    const fresh = { ...built, steps: [{ ...built.steps[0]!, state: "pending", attempts: undefined }] } as unknown as ItemRecord;
    const { bridge } = fakeBridge([fresh]);
    await open(bridge, fresh, "Checks");
    expect(text('[role="tabpanel"]')).toBe("No attempts yet. Tokama runs the checks after each Build attempt.");
    const noChecks = { ...setup, templates: [...baseSetup.templates, { ...TEMPLATE, steps: [{ ...TEMPLATE.steps[0], checks: undefined }] }] } as unknown as Setup;
    await open(bridge, fresh, "Checks", { setupData: noChecks });
    expect(text('[role="tabpanel"]')).toBe("This item's steps run no checks.");
  });

  it("opens every attempt that has checks with Expand all and closes them with Collapse all; each is disabled when it would do nothing", async () => {
    const { bridge } = fakeBridge([built]);
    await open(bridge, built, "Checks");
    const bar = () => $$(".ck .sec-bar .btn") as HTMLButtonElement[];
    expect($(".ck .sec-bar span")?.textContent).toBe("2 attempts");
    expect(bar().map((b) => [b.textContent, b.disabled])).toEqual([["Expand all", false], ["Collapse all", false]]);
    await click(bar()[0]);
    expect(lines(".ck").map((line) => line.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect(bar()[0]!.disabled).toBe(true);
    await click(bar()[1]);
    expect(lines(".ck").map((line) => line.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(bar().map((b) => b.disabled)).toEqual([false, true]);
  });

  it("keeps what was opened when the tab is left and came back to", async () => {
    const { bridge } = fakeBridge([built]);
    await open(bridge, built, "Checks");
    await click(lines(".ck")[1]);
    expect(lines(".ck").map((line) => line.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    await click(tab("Steps"));
    await click(tab("Checks"));
    expect(lines(".ck").map((line) => line.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  });

  it("marks the full view", async () => {
    const { bridge } = fakeBridge([built]);
    await open(bridge, built, "Checks", { full: true });
    expect($(".ck")?.getAttribute("data-full")).toBe("true");
  });
});

describe("Log tab", () => {
  it("shows one closed line per agent step, with no transcript asked for until a step is opened", async () => {
    const { bridge, query } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    expect($(".lg .sec-bar span")?.textContent).toBe("3 steps · 4 attempts · 48 KB");
    const steps = lines(".lg");
    expect(steps.map((line) => [line.querySelector(".sec-name")?.textContent, line.querySelector(".sec-agent")?.textContent, stateOf(line), line.querySelector(".sec-facts")?.textContent, line.tagName])).toEqual([
      ["Plan", "Architect", "✓done", "1 attempt · 6 m 12 s · 22 KB", "BUTTON"],
      ["Build", "Local builder", "✕failed", "3 attempts · 4 m 12 s · 26 KB", "BUTTON"],
      ["Review", "Reviewer", "–not run", "no log", "DIV"],
    ]);
    expect(steps.map((line) => line.getAttribute("aria-expanded"))).toEqual(["false", "false", null]);
    expect($(".lg-body")).toBeNull();
    expect(asked(query, "attempt_log")).toEqual([]);
  });

  it("speaks a line with its units in words", async () => {
    const { bridge } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    expect(lines(".lg").map((line) => line.querySelector(".visually-hidden")?.textContent)).toEqual([
      ", 1 attempt, 6 minutes 12 seconds, 22 kilobytes",
      ", 3 attempts, 4 minutes 12 seconds, 26 kilobytes",
      ", no log",
    ]);
    // The seen facts are hidden from screen readers so they are not read twice.
    expect(lines(".lg")[0]?.querySelector(".sec-facts")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens a step on its attempts with the latest open, and asks for that transcript only", async () => {
    const { bridge, query } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    await click(lines(".lg")[1]);
    const attempts = $$(".lg .sec-sub > .sec-h > .sec-head");
    // The clock time is local, so it is matched, not compared.
    expect(attempts.map((line) => [line.querySelector(".sec-name")?.textContent, stateOf(line), line.querySelector(".sec-facts")?.textContent?.replace(/^\d\d:\d\d/, "hh:mm"), line.getAttribute("aria-expanded")])).toEqual([
      ["Attempt 1", "✕checks failed", "hh:mm · 1 m 31 s · 14 KB", "false"],
      ["Attempt 2 · fresh session", "✕checks failed", "hh:mm · 1 m 22 s", "false"],
      ["Attempt 3 · fresh session", "✕checks failed", "hh:mm · 1 m 19 s · 12 KB", "true"],
    ]);
    expect(asked(query, "attempt_log").map((q) => q.attempt)).toEqual([3]);
    expect(text(".lg-text")).toBe("Third try.");
  });

  it("shows an earlier attempt's transcript, tool calls as → lines, the agent's words as text, and the final message", async () => {
    const { bridge } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    await click(lines(".lg")[1]);
    await click($$(".lg .sec-sub > .sec-h > .sec-head")[0]);
    const first = $$(".lg-box")[0]!;
    expect([...first.querySelectorAll(".lg-line")].map((line) => [line.getAttribute("data-kind"), line.textContent])).toEqual([
      ["text", "I'll follow the plan."],
      ["tool", "→Read src/orders/list.ts"],
      ["tool", "→Edit src/orders/list.ts"],
      ["text", "Done <script>x</script>"],
    ]);
    expect(container.querySelector("script")).toBeNull();
    expect(first.querySelector(".lg-cap")?.textContent).toBe("Showing the last 6 of 1,180 lines · 212 KBOpen the file");
    expect(first.querySelector(".lg-final")?.textContent).toBe("Final message · Local builderDone. GET /orders takes ?cursor=.");
    // Opening it did not close the latest: the engineer's choices are kept.
    expect($$(".lg-box")).toHaveLength(2);
  });

  it("says an attempt's transcript was not saved without asking for it", async () => {
    const { bridge, query } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    await click(lines(".lg")[1]);
    await click($$(".lg .sec-sub > .sec-h > .sec-head")[1]);
    expect($$(".lg-none").map((el) => el.textContent)).toEqual(["The transcript of this attempt was not saved."]);
    expect(asked(query, "attempt_log").map((q) => q.attempt)).toEqual([3]);
  });

  it("opens the transcript file by name, never by a path", async () => {
    const { bridge, openAttemptFile } = fakeBridge([built]);
    await open(bridge, built, "Log");
    await click(lines(".lg")[0]);
    await click($$(".lg .sec-sub > .sec-h > .sec-head")[0]);
    await click($(".lg-cap .open-file")!);
    expect(openAttemptFile).toHaveBeenCalledWith({ itemId: built.id, stepIndex: 0, attempt: 1, file: "transcript" });
  });

  it("follows a running step: attempt of limit on its line, its time counting while closed, its transcript read again only while open", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const running = { ...built, steps: [{ ...built.steps[0]!, attempts: [{ attempt: 1, result: "failed", startedAt: 1_000, durationMs: 4_000, checks: [] }, { attempt: 2, startedAt: 8_000, checks: [] }] }] } as unknown as ItemRecord;
    const { bridge, query } = fakeBridge([running]);
    await open(bridge, running, "Log");
    expect(lines(".lg")[0]?.querySelector(".sec-facts")?.textContent).toBe("attempt 2 of 3 · 6 s");
    await act(async () => vi.advanceTimersByTime(3000));
    expect(lines(".lg")[0]?.querySelector(".sec-facts")?.textContent).toBe("attempt 2 of 3 · 9 s");
    expect(asked(query, "attempt_log")).toEqual([]);
    await click(lines(".lg")[0]);
    const polled = () => asked(query, "attempt_log").length;
    const before = polled();
    expect(before).toBe(1);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(polled()).toBe(before + 1);
    // Closed again: no more reads, and the line's time still counts.
    await click(lines(".lg")[0]);
    await act(async () => vi.advanceTimersByTime(4000));
    expect(polled()).toBe(before + 1);
    expect(lines(".lg")[0]?.querySelector(".sec-facts")?.textContent).toBe("attempt 2 of 3 · 15 s");
  });

  it("does not read an ended attempt again", async () => {
    vi.useFakeTimers();
    const { bridge, query } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    await click(lines(".lg")[1]);
    await act(async () => vi.advanceTimersByTime(6000));
    expect(asked(query, "attempt_log")).toHaveLength(1);
  });

  it("opens every step on its latest attempt with Expand all and closes everything with Collapse all; each is disabled when it would do nothing", async () => {
    const { bridge, query } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    const bar = () => $$(".lg .sec-bar .btn") as HTMLButtonElement[];
    expect(bar().map((b) => [b.textContent, b.disabled])).toEqual([["Expand all", false], ["Collapse all", true]]);
    await click(bar()[0]);
    expect(lines(".lg").map((line) => line.getAttribute("aria-expanded"))).toEqual(["true", "true", null]);
    expect(asked(query, "attempt_log").map((q) => q.attempt)).toEqual([1, 3]);
    expect(bar().map((b) => b.disabled)).toEqual([true, false]);
    await click(bar()[1]);
    expect(lines(".lg").map((line) => line.getAttribute("aria-expanded"))).toEqual(["false", "false", null]);
    expect($(".lg-body")).toBeNull();
  });

  it("keeps what was opened while the app runs, per item: back on the tab the step is still open", async () => {
    const { bridge } = fakeBridge([threeSteps, built]);
    await open(bridge, threeSteps, "Log");
    await click(lines(".lg")[1]);
    await click(tab("Steps"));
    await click(tab("Log"));
    expect(lines(".lg").map((line) => line.getAttribute("aria-expanded"))).toEqual(["false", "true", null]);
    await open(bridge, built, "Log");
    expect(lines(".lg").map((line) => line.getAttribute("aria-expanded"))).toEqual(["false"]);
  });

  it("makes every step with a log a button Tab reaches, and a step with none a plain line", async () => {
    const { bridge } = fakeBridge([threeSteps]);
    await open(bridge, threeSteps, "Log");
    const focusable = $$(".lg button.sec-head").map((el) => (el as HTMLButtonElement).tabIndex);
    expect(focusable).toEqual([0, 0]);
    expect($(".lg .sec-head[data-plain]")?.hasAttribute("tabindex")).toBe(false);
  });

  it("has an empty text before any agent ran", async () => {
    const fresh = { ...built, steps: [{ ...built.steps[0]!, state: "pending", attempts: undefined }] } as unknown as ItemRecord;
    await open(fakeBridge([fresh]).bridge, fresh, "Log");
    expect(text('[role="tabpanel"]')).toBe("No agent has run yet. Each attempt's transcript appears here.");
  });

  it("says a transcript that is not there yet has no lines yet, and one that failed to load why", async () => {
    const early = fakeBridge([built], { logs: { 2: { attempt: 2, transcript: null, final: null } } });
    await open(early.bridge, built, "Log");
    await click(lines(".lg")[0]);
    expect(text(".lg-none")).toBe("No lines yet.");
    const broken = fakeBridge([built], { logs: {} });
    await open(broken.bridge, built, "Log");
    expect(text("[role='alert']")).toBe("✕Could not load the transcript: nothing for attempt_log");
  });
});
