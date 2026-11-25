// @vitest-environment happy-dom
import type { ItemRecord, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenResult, TokamaBridge } from "../../shared/bridge.js";
import { setup as baseSetup, task } from "../testing/drawer.js";
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
      attempts: [
        { attempt: 1, result: "failed", checks: [{ command: "pnpm test", passed: false, exitCode: 1 }, { command: "pnpm lint", passed: true, exitCode: 0 }] },
        { attempt: 2, checks: [] },
      ],
    },
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

async function open(bridge: TokamaBridge, item: ItemRecord, name: string, options: { full?: boolean; setupData?: Setup } = {}) {
  const expanded = options.full === true ? { back: "All work", wide: true, onCollapse: vi.fn() } : undefined;
  await act(async () => root.render(<ItemDrawer bridge={bridge} itemId={item.id} setup={options.setupData ?? setup} onClose={vi.fn()} expanded={expanded} />));
  await click(tab(name));
}

describe("Checks tab", () => {
  it("shows one section per attempt, oldest first; a failed check opens with its output, a passed one starts folded, waiting ones have no output", async () => {
    const { bridge } = fakeBridge([built]);
    await open(bridge, built, "Checks");
    expect($$(".ck-attempt-head").map((el) => el.textContent)).toEqual(["✕Attempt 1failed · 1 of 2 checks failed", "●Attempt 2 · fresh sessionrunning"]);
    const [first, second] = $$(".ck-attempt");
    const rows = [...first!.querySelectorAll(".ck-check")];
    expect(rows.map((row) => [row.getAttribute("data-state"), row.querySelector(".ck-result")?.textContent, row.querySelector(".ck-cmd")?.textContent, row.querySelector(".ck-exit")?.textContent, row.querySelector(".ck-dur")?.textContent, row.querySelector(".ck-sum")?.textContent])).toEqual([
      ["failed", "✕ failed", "$ pnpm test", "exit 1", "1 min 52 s", "2 failing · 416 passed"],
      ["passed", "✓ passed", "$ pnpm lint", "exit 0", "–", "No problems found."],
    ]);
    expect(rows.map((row) => (row.querySelector("details") as HTMLDetailsElement).open)).toEqual([true, false]);
    expect([...second!.querySelectorAll(".ck-check")].map((row) => [row.querySelector("details"), row.querySelector(".ck-result")?.textContent, row.querySelector(".ck-exit")?.textContent, row.querySelector(".ck-sum")?.textContent])).toEqual([
      [null, "○ waiting", "–", "runs when Build ends"],
      [null, "○ waiting", "–", "runs when Build ends"],
    ]);
  });

  it("shows the output as text only, with the cap note and Open the file for the rest", async () => {
    const { bridge, openAttemptFile } = fakeBridge([built], {}, async () => ({ ok: false, message: "Tokama does not open check-1.log: it is a link." }));
    await open(bridge, built, "Checks");
    const failed = $(".ck-check[data-state='failed']")!;
    expect(failed.querySelector(".ck-lines")?.textContent).toBe(FAIL_OUTPUT);
    expect(container.querySelector("script")).toBeNull();
    expect(failed.querySelector(".ck-cap")?.textContent).toBe("Last 3 of 1,312 lines · 96 KB");
    // The passed check's output is complete: no cap note and no button.
    expect($(".ck-check[data-state='passed'] .open-file")).toBeNull();
    await click(failed.querySelector(".open-file")!);
    expect(openAttemptFile).toHaveBeenCalledWith({ itemId: built.id, stepIndex: 0, attempt: 1, file: 1 });
    expect(failed.querySelector(".open-file-problem")?.textContent).toBe("!Could not open it: Tokama does not open check-1.log: it is a link.");
  });

  it("says when an output or an attempt's checks were not saved, and why an attempt ran none", async () => {
    const stopped = { ...built, steps: [{ ...built.steps[0]!, state: "failed", attempts: [{ attempt: 1, result: "run_failed", detail: "The check could not run. `pnpm test` was refused by the command policy.", checks: [] }] }] } as unknown as ItemRecord;
    const { bridge } = fakeBridge([stopped], { checks: { 1: { attempt: 1, checks: [] } } });
    await open(bridge, stopped, "Checks");
    expect(text(".ck-none")).toBe("No checks ran in this attempt.The check could not run. `pnpm test` was refused by the command policy.");

    const refused = { ...stopped, steps: [{ ...stopped.steps[0]!, attempts: [{ attempt: 1, result: "run_failed", detail: "The check could not run. `pnpm lint` was refused by the command policy.", checks: [{ command: "pnpm test", passed: true, exitCode: 0 }] }] }] } as unknown as ItemRecord;
    const withRow = fakeBridge([refused], {
      checks: { 1: { attempt: 1, checks: [{ command: "pnpm test", state: "passed", exitCode: 0, durationMs: 1000, summary: "", output: null }, { command: "pnpm lint", state: "not_run", exitCode: null, durationMs: null, summary: "The check could not run. `pnpm lint` was refused by the command policy.", output: null }] } },
    });
    await open(withRow.bridge, refused, "Checks");
    const notRun = $(".ck-check[data-state='not_run']")!;
    expect([notRun.querySelector(".ck-result")?.textContent, notRun.querySelector(".ck-exit")?.textContent, notRun.querySelector(".ck-sum")?.textContent]).toEqual(["! did not run", "–", "The check could not run. `pnpm lint` was refused by the command policy."]);

    const lost = fakeBridge([built], { checks: { ...CHECKS, 1: { attempt: 1, checks: [{ command: "pnpm test", state: "failed", exitCode: 1, durationMs: null, summary: "", output: null }] } } });
    await open(lost.bridge, built, "Checks");
    expect(text(".ck-out-none")).toBe("The output of this check was not saved.");
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

  it("lays the commands out in columns in the full view", async () => {
    const { bridge } = fakeBridge([built]);
    await open(bridge, built, "Checks", { full: true });
    expect($(".ck")?.getAttribute("data-full")).toBe("true");
    expect($$(".ck-columns")[0]?.textContent).toBe("ResultCommandExitDurationSummary");
  });
});

describe("Log tab", () => {
  it("shows each attempt's transcript, oldest first: tool calls as → lines, the agent's words as text, and the final message", async () => {
    const { bridge } = fakeBridge([built]);
    await open(bridge, built, "Log");
    expect($$(".lg-title").map((el) => el.textContent)).toEqual(["Build · attempt 1", "Build · attempt 2, fresh session"]);
    const first = $$(".lg-attempt")[0]!;
    expect([...first.querySelectorAll(".lg-line")].map((line) => [line.getAttribute("data-kind"), line.textContent])).toEqual([
      ["text", "I'll follow the plan."],
      ["tool", "→Read src/orders/list.ts"],
      ["tool", "→Edit src/orders/list.ts"],
      ["text", "Done <script>x</script>"],
    ]);
    expect(container.querySelector("script")).toBeNull();
    expect(first.querySelector(".lg-cap")?.textContent).toBe("Showing the last 6 of 1,180 lines · 212 KBOpen the file");
    expect(first.querySelector(".lg-final")?.textContent).toBe("Final message · Local builderDone. GET /orders takes ?cursor=.");
    // The running attempt has no lines and no final message yet.
    expect($$(".lg-attempt")[1]?.querySelector(".lg-none")?.textContent).toBe("No lines yet.");
    expect($$(".lg-attempt")[1]?.querySelector(".lg-final")).toBeNull();
  });

  it("opens the transcript file by name, never by a path", async () => {
    const { bridge, openAttemptFile } = fakeBridge([built]);
    await open(bridge, built, "Log");
    await click($(".lg-cap .open-file")!);
    expect(openAttemptFile).toHaveBeenCalledWith({ itemId: built.id, stepIndex: 0, attempt: 1, file: "transcript" });
  });

  it("reads a running attempt again every few seconds while the tab is open, and stops when it closes", async () => {
    vi.useFakeTimers();
    const { bridge, query } = fakeBridge([built]);
    await open(bridge, built, "Log");
    const asked = () => query.mock.calls.filter(([q]) => q.type === "attempt_log" && q.attempt === 2).length;
    const before = asked();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(asked()).toBe(before + 1);
    // The ended attempt is not read again.
    expect(query.mock.calls.filter(([q]) => q.type === "attempt_log" && q.attempt === 1)).toHaveLength(1);
    await click(tab("Steps"));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(asked()).toBe(before + 1);
  });

  it("says a transcript was not saved, and has an empty text before any agent ran", async () => {
    const { bridge } = fakeBridge([built], { logs: { ...LOGS, 1: { attempt: 1, transcript: null, final: null } } });
    await open(bridge, built, "Log");
    expect($$(".lg-attempt")[0]?.querySelector(".lg-none")?.textContent).toBe("The transcript of this attempt was not saved.");
    // A running attempt whose transcript file is not there yet has no lines yet.
    const early = fakeBridge([built], { logs: { ...LOGS, 2: { attempt: 2, transcript: null, final: null } } });
    await open(early.bridge, built, "Log");
    expect($$(".lg-attempt")[1]?.querySelector(".lg-none")?.textContent).toBe("No lines yet.");
    const fresh = { ...built, steps: [{ ...built.steps[0]!, state: "pending", attempts: undefined }] } as unknown as ItemRecord;
    await open(fakeBridge([fresh]).bridge, fresh, "Log");
    expect(text('[role="tabpanel"]')).toBe("No agent has run yet. Each attempt's transcript appears here.");
  });
});
