// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenResult } from "../../shared/bridge.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { setup } from "../testing/sample.js";
import { builtinEntry, flakyDetail, flakyEntry, planDetail, planEntry } from "../testing/templates.js";
import { TemplatesPage } from "./TemplatesPage.js";

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

const builtinDetail = { ...planDetail, entry: builtinEntry, path: null };
const DETAILS: Record<string, unknown> = { [planEntry.file]: planDetail, [flakyEntry.file]: flakyDetail, [builtinEntry.file]: builtinDetail };

function bridgeWith(options: { entries?: unknown[]; detail?: (query: { file?: string }) => Reply | undefined; openTemplateFile?: () => Promise<OpenResult> } = {}) {
  return fakeBridge(CONNECTED, {
    reply: (query: { type: string; file?: string }) => {
      if (query.type === "templates") return { ok: true, data: { templates: options.entries ?? [planEntry, flakyEntry, builtinEntry] } };
      if (query.type === "template_detail") return options.detail?.(query) ?? (DETAILS[query.file ?? ""] ? { ok: true, data: DETAILS[query.file ?? ""] } : { ok: false, error: { code: "not_found", message: "no such file" } });
      return undefined;
    },
    ...(options.openTemplateFile && { openTemplateFile: options.openTemplateFile }),
  });
}

const render = async (fake: ReturnType<typeof fakeBridge>) => {
  await act(async () => root.render(<TemplatesPage bridge={fake.bridge} connection={CONNECTED} agents={setup.agents as never} connections={setup.connections as never} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const fileLine = () => $$("button[aria-expanded]").find((el) => el.textContent?.startsWith("File"));
const button = (label: string) => $$("button").find((el) => el.textContent === label);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("TemplatesPage", () => {
  it("lists each file with its icon, name, place and state in a symbol and a word", async () => {
    await render(bridgeWith());
    expect($$(".tp-row").map((row) => [row.querySelector(".tp-row-name")?.textContent, row.querySelector(".tp-status")?.textContent, row.querySelector(".tp-row-place")?.textContent])).toEqual([
      ["Plan and build", "✓ valid", "orders-api/.tokama/templates/plan-and-build.yaml"],
      ["flaky-test-fix.yaml", "✕ 2 problems", "checkout-web/.tokama/templates/flaky-test-fix.yaml"],
      ["Quick fix", "✓ valid", "built-in"],
    ]);
    expect($$(".tp-row .tpl-icon")).toHaveLength(3);
    expect($(".tp-list-foot")?.textContent).toContain("3 templates from 2 repos and built-in.");
  });

  it("shows the first template: Start, what it can use, the flow, a sentence per step and Finish", async () => {
    await render(bridgeWith());
    expect($('.tp-row[aria-pressed="true"] .tp-row-name')?.textContent).toBe("Plan and build");
    const section = (name: string) => $(`section[aria-label="${name}"]`)?.textContent ?? "";
    expect(section("Start")).toContain("Needs a task description and one repo.");
    expect(section("Can use")).toContain("the repo you pick · edit · gets a worktree");
    expect(section("Can use")).toContain("pnpm test");
    expect($('[role="img"]')?.getAttribute("aria-label")).toContain("Start → Plan → Build → Review → Finish");
    expect($$(".tp-loop-label").map((el) => el.textContent)).toEqual(["checks fail · retry, up to 3", "changes · back to Build"]);
    expect($$(".tp-steps li").map((li) => li.textContent)).toEqual([
      "1Plan: Architect (Claude Code, cloud) works in the item’s worktree; sends the repo and diff to the cloud; done when you approve; if it fails, ask you.",
      "2Build: Local builder (Claude Code, this machine) works in the item’s worktree; done when the repo’s checks pass; if checks fail, try again, up to 3 attempts.",
      "3Review: Reviewer (Codex CLI, cloud) reviews the work; sends the repo and diff to the cloud; done when it approves; if it asks for changes, send the work back to Build and check again after each fix, up to 3 round trips, then ask you.",
    ]);
    expect(section("You get at the end")).toBe("You get at the end✓Commit · on the item’s branch✓Pull request · opened from the item’s branch");
    expect($(".tp-head")?.textContent).toContain("budget 1 h 30 m");
  });

  it("shows a broken file's problems with their lines; a line opens the file there", async () => {
    await render(bridgeWith());
    await click($$(".tp-row")[1]!);
    await settle();
    expect($(".tp-problems-title")?.textContent).toBe("✕ 2 problems");
    expect($$(".tp-problems li").map((li) => li.textContent)).toEqual([
      'line 3Step "review" uses agent "reviewr", which is not set up. Did you mean "reviewer"?',
      'line 5Step "review": "if_changes_requested" goes back to "buld", which is not a step in this template. Did you mean "build"?',
    ]);
    expect($('section[aria-label="Steps"]')).toBeNull();
    expect($(".tp-file")).toBeNull();
    await click(button("line 5")!);
    const lines = $$(".tp-file-line");
    expect(lines).toHaveLength(5);
    expect(lines.filter((line) => line.hasAttribute("data-problem")).map((line) => line.textContent)).toEqual(["3✕    agent: reviewr", "5✕      back: buld"]);
    expect($('.tp-file-line[data-mark] .tp-file-n')?.textContent).toBe("5");
    expect(fileLine()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a warning of a template that loads, with its line, under Worth knowing", async () => {
    const warning = 'Line 14: Step "review": "if_failed" has no effect on a reviewer step; use "if_changes_requested".';
    await render(bridgeWith({ detail: () => ({ ok: true, data: { ...planDetail, warnings: [warning] } }) }));
    expect($('section[aria-label="Worth knowing"]')?.textContent).toContain(warning);
  });

  it("folds the file under a File line: closed to start with, not in the page until it is opened", async () => {
    await render(bridgeWith());
    expect(fileLine()?.getAttribute("aria-expanded")).toBe("false");
    expect($(".tp-file")).toBeNull();
    await click(fileLine()!);
    expect($(".tp-file")?.textContent).toContain("name: Plan and build");
    expect(fileLine()?.getAttribute("aria-expanded")).toBe("true");
    await click(fileLine()!);
    expect($(".tp-file")).toBeNull();
  });

  it("opens the file in the editor by its origin and file, and says why it did not open", async () => {
    const fake = bridgeWith({ openTemplateFile: async () => ({ ok: false, message: "no app for .yaml" }) });
    await render(fake);
    await click(button("Open in editor")!);
    expect(fake.openTemplateFile).toHaveBeenCalledWith({ origin: "orders-api", file: ".tokama/templates/plan-and-build.yaml" });
    expect($('[role="alert"]')?.textContent).toBe("✕ no app for .yaml");
  });

  it("offers no editor for a built-in or a file that is not on this machine", async () => {
    await render(bridgeWith());
    await click($$(".tp-row")[2]!);
    await settle();
    expect(button("Open in editor")).toBeUndefined();
    expect($(".tp-source")?.textContent).toBe("Ships with Tokama.");
    await click($$(".tp-row")[1]!);
    await settle();
    expect(button("Open in editor")).toBeUndefined();
    expect($(".tp-actions")?.textContent).toContain("There is no file on this machine to open.");
  });

  it("filters the list by name and place", async () => {
    await render(bridgeWith());
    const input = $('input[aria-label="Filter templates"]') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "checkout");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect($$(".tp-row .tp-row-name").map((el) => el.textContent)).toEqual(["flaky-test-fix.yaml"]);
  });

  it("keeps the problems and says so when the file is too large to send", async () => {
    const big = { ...flakyDetail, text: null, textTooLarge: true };
    await render(bridgeWith({ entries: [flakyEntry], detail: () => ({ ok: true, data: big }) }));
    expect($$(".tp-problems li")).toHaveLength(2);
    expect(button("line 3")).toBeUndefined();
    expect(fileLine()).toBeUndefined();
    expect($(".tp-actions")?.textContent).toContain("The file is too large to show here");
  });

  it("renders engine and file text as text, never as markup", async () => {
    const hostile = { ...flakyDetail, problems: [{ line: 1, message: "<img src=x onerror=alert(1)>" }], text: "<script>alert(1)</script>\n" };
    await render(bridgeWith({ entries: [flakyEntry], detail: () => ({ ok: true, data: hostile }) }));
    await click(button("line 1")!);
    expect($("img")).toBeNull();
    expect($("script")).toBeNull();
    expect($(".tp-problems")?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect($(".tp-file")?.textContent).toContain("<script>alert(1)</script>");
  });

  it("reads the files again on Check again, when the setup changes and when the window gets focus", async () => {
    const fake = bridgeWith();
    await render(fake);
    const asked = () => fake.query.mock.calls.filter(([query]) => (query as { type: string }).type === "templates").length;
    expect(asked()).toBe(1);
    await click(button("Check again")!);
    await fake.pushEvent({ type: "setup_changed" });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(asked()).toBe(4);
  });

  it("says when there are no templates, and when the list cannot be read", async () => {
    await render(bridgeWith({ entries: [] }));
    expect($(".tp-list")?.textContent).toContain("No templates found");
    act(() => root.unmount());
    root = createRoot(container);
    const failing = fakeBridge(CONNECTED, { reply: () => ({ ok: false, error: { code: "internal", message: "the engine failed" } }) });
    await render(failing);
    expect($('[role="alert"]')?.textContent).toBe("✕ the engine failed");
  });
});
