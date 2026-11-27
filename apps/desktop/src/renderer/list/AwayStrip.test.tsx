// @vitest-environment happy-dom
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_STATE } from "../../shared/desktop-state.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, SETUP_DONE } from "../testing/bridge.js";
import { ITEMS, NOW } from "../testing/sample.js";

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
const SEEN = NOW - 100 * MINUTE;
const DUE = { seenUntil: SEEN, due: true, backAt: NOW } as const;

const asked = (item: ItemRecord, minutesAgo: number): ItemRecord => ({ ...item, decision: { ...item.decision!, askedAt: NOW - minutesAgo * MINUTE } }) as ItemRecord;
const ended = (item: ItemRecord, minutesAgo: number, fields: Record<string, unknown> = {}): ItemRecord =>
  ({ ...item, ...fields, outcome: { kind: item.state === "failed" ? "failed" : item.state === "stopped" ? "stopped" : "done", at: NOW - minutesAgo * MINUTE } }) as ItemRecord;
const id = (n: number) => `item_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** One question, one finished, one failed and one stopped item since SEEN, one older item, and three that run. */
const NEWS: ItemRecord[] = [asked(ITEMS.needsYou, 30), ended(ITEMS.done, 60), ended(ITEMS.failed, 50), ended(ITEMS.stopped, 40), ended(ITEMS.doneLastWeek, 4000), ITEMS.working, ITEMS.verifying, ITEMS.stock];

const mount = async (options: Parameters<typeof fakeBridge>[1], extra: { initial?: typeof DEFAULT_DESKTOP_STATE } = {}) => {
  const fake = fakeBridge(CONNECTED, options);
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} initial={extra.initial ?? SETUP_DONE} />));
  return fake;
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const strip = () => $('section[aria-label="While you were away"]');
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const buttonIn = (scope: Element | null, label: string | RegExp) => [...(scope?.querySelectorAll("button") ?? [])].find((el) => (typeof label === "string" ? el.textContent === label : label.test(el.getAttribute("aria-label") ?? el.textContent ?? "")));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the While you were away strip", () => {
  it("shows one line with its counts, each with its symbol and word, and Show and Got it", async () => {
    await mount({ boardItems: NEWS, away: DUE });
    const section = strip();
    expect(section).not.toBeNull();
    expect(text(section)).toContain("While you were away");
    expect(text(section)).toContain("1 h 40 m");
    expect(text(section)).toContain("⏸ 1 needs you");
    expect(text(section)).toContain("✓ 1 finished");
    expect(text(section)).toContain("✕ 1 failed");
    expect(text(section)).toContain("3 still running");
    expect(buttonIn(section, "Show")).toBeDefined();
    expect(buttonIn(section, "Got it")).toBeDefined();
    // Closed: no lines.
    expect($$(".away-line")).toHaveLength(0);
    // The stopped item is not news, and the item from last week ended before the user left.
    expect(text(section)).not.toContain("2 finished");
  });

  it("shows nothing when the user was not away", async () => {
    await mount({ boardItems: NEWS, away: { seenUntil: SEEN, due: false } });
    expect(strip()).toBeNull();
  });

  it("shows nothing when nothing asked, ended or failed since, however much runs", async () => {
    await mount({ boardItems: [ended(ITEMS.done, 400), asked(ITEMS.needsYou, 300), ITEMS.working, ITEMS.verifying], away: DUE });
    expect(strip()).toBeNull();
  });

  it("opens to the groups in order, every line with the item's own sentence, and ends with what still runs", async () => {
    await mount({ boardItems: NEWS, away: DUE });
    await click(buttonIn(strip(), "Show"));
    const section = strip();
    expect($$(".away-group-heading").map((heading) => text(heading))).toEqual(["⏸Needs you1", "✓Finished1", "✕Failed1"]);
    const lines = $$(".away-line").map((line) => text(line));
    expect(lines[0]).toContain("Orders API returns 500 after deploy");
    expect(lines[0]).toContain("Send the redacted findings summary to Architect on Claude Code?");
    expect(lines[1]).toContain("Bump the Postgres driver");
    expect(lines[2]).toContain("Flaky checkout test");
    expect(lines[2]).toContain("stopped at Fix, step 1 of 2");
    expect(text($(".away-running"))).toContain("Still running:");
    expect(text($(".away-running"))).toContain("Checkout p95 latency spike");
    expect(text($(".away-running"))).toContain("Local builder");
    // The running items show the working agent's badge, with its name in words.
    expect($$(".away-running .ag-badge").length).toBeGreaterThan(0);
    expect(buttonIn(section, "Hide")).toBeDefined();
    expect(text(section)).toContain("to 15:00 · 1 h 40 m");
  });

  it("fills only the oldest question's button", async () => {
    const older = { ...asked(ITEMS.needsYou, 80), id: id(77), title: "An older question" } as ItemRecord;
    await mount({ boardItems: [...NEWS, older], away: DUE });
    await click(buttonIn(strip(), "Show"));
    const buttons = $$(".away-line .btn").filter((button) => /Open the question/.test(button.getAttribute("aria-label") ?? ""));
    expect(buttons.map((button) => [button.getAttribute("aria-label"), button.classList.contains("btn-primary")])).toEqual([
      ["Open the question: An older question", true],
      ["Open the question: Orders API returns 500 after deploy", false],
    ]);
    expect($$(".away-line .btn-primary")).toHaveLength(1);
  });

  it("opens the item from its line", async () => {
    const fake = await mount({ boardItems: NEWS, away: DUE });
    await click(buttonIn(strip(), "Show"));
    await click(buttonIn(strip(), /^Open the question/));
    expect(fake.query).toHaveBeenCalledWith({ type: "item", itemId: ITEMS.needsYou.id });
  });

  it("Got it asks the main process to see everything and the strip goes", async () => {
    const fake = await mount({ boardItems: NEWS, away: DUE });
    await click(buttonIn(strip(), "Got it"));
    expect(fake.closeAway).toHaveBeenCalledTimes(1);
    expect(strip()).toBeNull();
  });

  it("comes in when the main process says the user is back, with no reload", async () => {
    const fake = await mount({ boardItems: NEWS, away: { seenUntil: SEEN, due: false } });
    expect(strip()).toBeNull();
    await fake.setAway(DUE);
    expect(strip()).not.toBeNull();
  });

  it("shows five lines of a group, then 'and N more' that switches the list to it", async () => {
    const finished = Array.from({ length: 7 }, (_, n) => ended(ITEMS.done, 30 + n, { id: id(100 + n), title: `Done ${n + 1}` }));
    await mount({ boardItems: [...finished, ITEMS.working], away: DUE });
    await click(buttonIn(strip(), "Show"));
    expect($$(".away-line")).toHaveLength(5);
    expect(text($(".away-group-more"))).toBe("and 2 more");
    await click(buttonIn(strip(), "and 2 more"));
    expect($(".filter-bar .segment[aria-pressed='true']")?.textContent).toContain("Done");
  });

  it("offers Merge on a finished item that can be merged, and Open otherwise", async () => {
    const mergeable = {
      ...ended(ITEMS.done, 20, { id: id(55), title: "Show tax on the receipt total", finish: { worktreeRemoved: false } }),
      outcome: { kind: "done", at: NOW - 20 * MINUTE, commits: [{ repoId: "orders-api", commit: "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567", branch: "tokama/0b9f3c1e" }] },
    } as ItemRecord;
    await mount({ boardItems: [mergeable, ended(ITEMS.failed, 50), ITEMS.working], away: DUE });
    await click(buttonIn(strip(), "Show"));
    const lines = $$(".away-line");
    expect(lines).toHaveLength(2);
    const finishedLine = lines.find((line) => text(line).includes("Show tax on the receipt total"))!;
    expect(finishedLine.querySelector(".finish-split")).not.toBeNull();
    expect(buttonIn(finishedLine, /^Open/)).toBeUndefined();
    expect(buttonIn(lines.find((line) => text(line).includes("Flaky checkout test")) ?? null, /^Open/)).toBeDefined();
  });

  it("is on All work only", async () => {
    const view = { ...SETUP_DONE, lastView: { kind: "workflow" as const, id: "builtin/quick-fix" } };
    await mount({ boardItems: NEWS, away: DUE }, { initial: view });
    expect(strip()).toBeNull();
  });

  it("renders engine text as text, never as markup", async () => {
    const hostile = ended(ITEMS.done, 20, { id: id(66), title: "<img src=x onerror=alert(1)>" });
    await mount({ boardItems: [hostile, ITEMS.working], away: DUE });
    await click(buttonIn(strip(), "Show"));
    expect($$(".away img")).toHaveLength(0);
    expect(text(strip())).toContain("<img src=x onerror=alert(1)>");
  });
});
