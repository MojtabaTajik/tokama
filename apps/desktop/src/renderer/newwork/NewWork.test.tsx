// @vitest-environment happy-dom
import type { ItemRecord, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { ITEMS, NOW, setup } from "../testing/sample.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  container.remove();
});

const NEW_ID = "item_1a2b3c4d-0099-4a1b-8c1d-000000000099";
const newItem = { ...ITEMS.queued, id: NEW_ID, title: "Fix the retry loop", templateId: "builtin/quick-fix", createdAt: NOW } as unknown as ItemRecord;
const SUGGEST = "builtin/plan-and-build";

interface Options {
  readonly suggest?: string | null;
  readonly commandReply?: Reply;
  readonly setup?: Setup;
  /** Answers `suggest_template` by hand, per text, instead of at once. */
  readonly suggestReply?: (text: string) => Promise<Reply>;
}
const mount = async (options: Options = {}) => {
  const fake = fakeBridge(CONNECTED, {
    reply: (q) => {
      if (q.type === "suggest_template" && options.suggestReply) return options.suggestReply((q as unknown as { text: string }).text);
      if (q.type === "suggest_template") return { ok: true, data: { templateId: options.suggest === undefined ? SUGGEST : options.suggest } };
      if (q.type === "setup" && options.setup) return { ok: true, data: options.setup };
      if (q.type === "item" && (q as { itemId?: string }).itemId === NEW_ID) return { ok: true, data: { item: newItem } };
      return undefined;
    },
    commandReply: () => options.commandReply ?? { ok: true, data: { itemId: NEW_ID } },
  });
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} />));
  return fake;
};

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const press = (el: Element | null | undefined, key: string, init: KeyboardEventInit = {}) =>
  act(async () => void el?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
const type = (el: Element | null, value: string) =>
  act(async () => {
    const field = el as HTMLTextAreaElement | HTMLInputElement;
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const input = () => $(".np-text") as HTMLTextAreaElement;
const focusInput = () => act(async () => input().focus());
const start = () => $(".np-start") as HTMLButtonElement;
const trigger = (label: string) => $$(".np-trigger").find((el) => el.querySelector(".np-trigger-label")?.textContent === label)!;
const search = () => $(".np-search") as HTMLInputElement;
const options = () => $$('[role="option"]').map((el) => el.textContent!.replace(/^✓/, ""));
const plus = (label: string) => $(`.sb-plus[aria-label="${label}"]`) as HTMLButtonElement;
const reason = () => $(".np-reason")?.textContent;

describe("New work input", () => {
  it("is one line until focused, then expands with the template, repos and steps, and no run option", async () => {
    await mount();
    expect($(".np-body")).toBeNull();
    expect(input().placeholder).toBe("Describe a task or paste an alert…");
    await focusInput();
    expect($(".np-body")).not.toBeNull();
    expect($$(".np-trigger").map((el) => el.textContent)).toEqual(["TemplateChoose…▾", "ReposChoose…▾"]);
    expect($('.np-body input[type="checkbox"]')).toBeNull();
    expect(start().textContent).toMatch(/^Start/);
  });

  it("marks the engine's suggestion as the user types, and uses it until they choose", async () => {
    const fake = await mount();
    await focusInput();
    await type(input(), "add retry to the payment client");
    await wait(300);
    const suggests = fake.query.mock.calls.filter(([q]) => q.type === "suggest_template");
    expect(suggests).toHaveLength(1);
    expect(suggests[0]![0]).toEqual({ type: "suggest_template", text: "add retry to the payment client" });
    expect(trigger("Template").textContent).toBe("TemplatePlan and build (suggested)▾");
    await click(trigger("Template"));
    expect($$('[role="option"]').filter((el) => el.querySelector(".np-tag")).map((el) => el.textContent)).toEqual(["✓Plan and buildsuggested"]);
    // Picking another template wins over the suggestion; the mark stays on the suggested one.
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    expect(trigger("Template").textContent).toBe("TemplateQuick fix▾");
    await click(trigger("Template"));
    expect($$(".np-tag").map((el) => el.parentElement?.textContent)).toEqual(["Plan and buildsuggested"]);
  });

  it("counts a suggestion only for the text it was made for, whatever order the replies arrive in", async () => {
    const waiting = new Map<string, (reply: Reply) => void>();
    await mount({ suggestReply: (text) => new Promise((resolve) => waiting.set(text, resolve)) });
    const answer = (text: string, templateId: string | null) => act(async () => waiting.get(text)!({ ok: true, data: { templateId } }));
    await focusInput();
    await type(input(), "a");
    await wait(300);
    await type(input(), "ab");
    await wait(300);
    expect([...waiting.keys()]).toEqual(["a", "ab"]);
    // The newer answer first, then the older one, which must not replace it.
    await answer("ab", "builtin/plan-and-build");
    await answer("a", "builtin/quick-fix");
    expect(trigger("Template").textContent).toBe("TemplatePlan and build (suggested)▾");
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    await click(trigger("Repos"));
    expect(start().disabled).toBe(false);

    // More typing: the old name stays, but Start waits for the answer to the current text.
    await type(input(), "abc");
    expect(trigger("Template").textContent).toBe("TemplatePlan and build (suggested)▾");
    expect(start().disabled).toBe(true);
    expect(reason()).toBe("Choose a template");
    await wait(300);
    await answer("abc", "builtin/quick-fix");
    expect(trigger("Template").textContent).toBe("TemplateQuick fix (suggested)▾");
    expect(start().disabled).toBe(false);

    // An error clears the suggestion.
    await type(input(), "abcd");
    await wait(300);
    await act(async () => waiting.get("abcd")!({ ok: false, error: { code: "not_implemented", message: "x" } }));
    expect(trigger("Template").textContent).toBe("TemplateChoose…▾");
    expect(reason()).toBe("Choose a template");
    // So does blank text.
    await type(input(), "abcde");
    await wait(300);
    await answer("abcde", "builtin/quick-fix");
    expect(trigger("Template").textContent).toBe("TemplateQuick fix (suggested)▾");
    await type(input(), "  ");
    expect(trigger("Template").textContent).toBe("TemplateChoose…▾");
  });

  it("does not let a stale suggestion override the user's own choice", async () => {
    const waiting = new Map<string, (reply: Reply) => void>();
    await mount({ suggestReply: (text) => new Promise((resolve) => waiting.set(text, resolve)) });
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Emergency investigator"))!);
    await type(input(), "5xx on checkout");
    expect(start().disabled).toBe(false);
  });

  it("asks nothing for blank text and shows no mark when the engine has no suggestion", async () => {
    const fake = await mount({ suggest: null });
    await focusInput();
    await type(input(), "   ");
    await wait(300);
    await type(input(), "something odd");
    await wait(300);
    expect(fake.query.mock.calls.filter(([q]) => q.type === "suggest_template")).toHaveLength(1);
    expect(trigger("Template").textContent).toBe("TemplateChoose…▾");
  });

  it("groups the templates as Investigate and Build", async () => {
    await mount();
    await focusInput();
    await click(trigger("Template"));
    expect($$('.np-list [role="group"]').map((group) => [group.getAttribute("aria-label"), [...group.querySelectorAll('[role="option"]')].map((el) => el.textContent)])).toEqual([
      ["Investigate", ["Emergency investigator", "DB slow query check"]],
      ["Build", ["Plan and build", "Quick fix", "Review only"]],
    ]);
    await type(search(), "slow");
    expect(options()).toEqual(["DB slow query check"]);
  });

  it("keeps Start disabled with a short reason until the needs are met", async () => {
    const fake = await mount({ suggest: null });
    await focusInput();
    expect(start().disabled).toBe(true);
    expect(reason()).toBe("Choose a template");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    expect(reason()).toBe("Describe the work or paste an alert");
    await type(input(), "Fix the retry loop");
    expect(reason()).toBe("Choose one repo");
    expect(trigger("Repos").textContent).toBe("ReposChoose…▾");
    // The blocked form sends nothing, by Ctrl+Enter or by a submit.
    await press(input(), "Enter", { ctrlKey: true });
    await act(async () => void $(".np-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fake.command).not.toHaveBeenCalled();
    await click(trigger("Repos"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("orders-api"))!);
    expect(reason()).toBe("");
    expect(start().disabled).toBe(false);
  });

  it("on a repo with no checks, says why Quick fix can't run and offers Quick change", async () => {
    const checked = (id: string) => (setup.templates.find((t) => t.id === id) ?? setup.templates[0]!);
    const quickFix = { ...checked("builtin/quick-fix"), steps: [{ name: "Fix", stage: "working", agentId: "local-builder", data: "none", checks: { from: "repo" } }] };
    const quickChange = { ...quickFix, id: "builtin/quick-change", name: "Quick change", steps: [{ name: "Change", stage: "review", agentId: "local-builder", data: "none" }] };
    const withBoth = { ...setup, templates: [...setup.templates.filter((t) => t.id !== "builtin/quick-fix"), quickFix, quickChange] } as unknown as Setup;
    const fake = await mount({ suggest: null, setup: withBoth });
    await focusInput();
    await type(input(), "Log the warehouse id");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent === "Quick fix")!);
    await click(trigger("Repos"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("inventory-service"))!);
    expect(reason()).toBe("Quick fix runs the repo's checks, and inventory-service lists none, so it can't run there.");
    expect(start().disabled).toBe(true);
    expect($(".np-suggest")?.textContent).toBe("Quick change lets you review the diff yourself instead. Use Quick change");

    await click($(".np-suggest button"));
    expect(trigger("Template").textContent).toContain("Quick change");
    expect($(".np-suggest")).toBeNull();
    expect(reason()).toBe("");
    await click(start());
    expect(fake.command).toHaveBeenCalledWith({ type: "start_item", templateId: "builtin/quick-change", repoIds: ["inventory-service"], text: "Log the warehouse id" });
  });

  it("needs no repo for an investigation, and says so", async () => {
    await mount({ suggest: null });
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Emergency investigator"))!);
    await type(input(), "5xx on checkout");
    expect(trigger("Repos").textContent).toBe("Reposnone (optional)▾");
    expect(start().disabled).toBe(false);
  });

  it("chooses the open repo's list repo, until the user picks repos themselves", async () => {
    await mount();
    await click($$(".sb-main").find((row) => row.querySelector(".ellipsis")?.textContent === "checkout-web"));
    await focusInput();
    expect(trigger("Repos").textContent).toBe("Reposcheckout-web▾");
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    expect(trigger("Repos").textContent).toBe("Repos2 repos▾");
    await click($$(".sb-main").find((row) => row.querySelector(".ellipsis")?.textContent === "All work"));
    expect(trigger("Repos").textContent).toBe("Repos2 repos▾");
  });

  it("searches repos and lets several be chosen", async () => {
    await mount();
    await focusInput();
    await click(trigger("Repos"));
    expect(options()).toEqual(["orders-api", "checkout-web", "inventory-service"]);
    await type(search(), "-web");
    expect(options()).toEqual(["checkout-web"]);
    await type(search(), "");
    await click($$('[role="option"]')[0]);
    await click($$('[role="option"]')[2]);
    expect($('[role="listbox"]')?.getAttribute("aria-multiselectable")).toBe("true");
    expect(trigger("Repos").textContent).toBe("Repos2 repos▾");
    await click($$('[role="option"]')[0]);
    expect(trigger("Repos").textContent).toBe("Reposinventory-service▾");
  });

  it("shows the template's connections as read-only 'uses' badges and its steps on one line", async () => {
    const withUses = {
      ...setup,
      templates: setup.templates.map((t) => (t.id === "builtin/emergency-investigator" ? { ...t, connections: [{ connectionId: "app-insights-prod", access: "query" }] } : t)),
    } as unknown as Setup;
    await mount({ setup: withUses });
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Emergency investigator"))!);
    expect($(".np-uses")?.textContent).toBe("usesApp Insights · prod (query)");
    expect($(".np-badge")?.tagName).toBe("SPAN");
    expect($(".np-steps")?.textContent).toBe("Steps: Triage · Local builder → Query logs · Local builder → Propose a fix · Architect (cloud)");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    expect($(".np-uses")).toBeNull();
  });

  it("uses a dialog popup and a status line for 'No match', and keeps the active option in view", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    // happy-dom has no scrollIntoView of its own: remove the stand-in when the test ends.
    onTestFinished(() => void delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView);
    await mount({ suggest: null });
    await focusInput();
    expect(trigger("Template").getAttribute("aria-haspopup")).toBe("dialog");
    await click(trigger("Template"));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    scroll.mockClear();
    await press(search(), "ArrowDown");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    await type(search(), "zzz");
    expect($('[role="listbox"]')?.textContent).toBe("");
    expect($('.np-popup [role="status"]')?.textContent).toBe("No match");
    expect($('[role="listbox"] [role="status"]')).toBeNull();
  });

  it("moves through a dropdown with the arrow keys and picks with Enter", async () => {
    await mount({ suggest: null });
    await focusInput();
    await click(trigger("Template"));
    expect(document.activeElement).toBe(search());
    await press(search(), "ArrowDown");
    await press(search(), "ArrowDown");
    expect($('[role="option"][data-active]')?.textContent).toBe("Plan and build");
    expect(search().getAttribute("aria-activedescendant")).toBe($('[role="option"][data-active]')?.id);
    await press(search(), "ArrowUp");
    await press(search(), "Enter");
    expect($('[role="listbox"]')).toBeNull();
    expect(trigger("Template").textContent).toBe("TemplateDB slow query check▾");
    expect(document.activeElement).toBe(trigger("Template"));
  });

  it("keeps a multi-select open on Enter and toggles", async () => {
    await mount();
    await focusInput();
    await click(trigger("Repos"));
    await press(search(), "Enter");
    await press(search(), "ArrowDown");
    await press(search(), "Enter");
    expect($('[role="listbox"]')).not.toBeNull();
    expect($$('[role="option"]').map((el) => el.getAttribute("aria-selected"))).toEqual(["true", "true", "false"]);
  });

  it("sends start_item with the form, then selects the new item and opens its drawer", async () => {
    const fake = await mount({ suggest: null });
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    await type(input(), "  Fix the retry loop  ");
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    await click(start());
    expect(fake.command).toHaveBeenCalledTimes(1);
    expect(fake.command).toHaveBeenCalledWith({ type: "start_item", templateId: "builtin/quick-fix", repoIds: ["orders-api"], text: "Fix the retry loop" });
    // The drawer opens at once; the row appears with the engine's event and is the selected one.
    await wait(0);
    expect($(".drawer h2")?.textContent).toBe("Fix the retry loop");
    await fake.pushItem(newItem);
    expect($('.pl-row[aria-current="true"] .pl-title')?.textContent).toBe("Fix the retry loop");
    // The input is empty and collapsed again.
    expect($(".np-body")).toBeNull();
    expect(input().value).toBe("");
  });

  it("has no ask-before-cloud option and sends no options: the engine decides their defaults", async () => {
    const fake = await mount();
    await focusInput();
    await type(input(), "Review the diff");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Review only"))!);
    expect(document.body.textContent).not.toContain("Ask before cloud steps");
    await click(trigger("Repos"));
    await click($$('[role="option"]')[1]);
    await press(input(), "Enter", { ctrlKey: true });
    expect(fake.command.mock.calls[0]![0]).toEqual({ type: "start_item", templateId: "builtin/review-only", repoIds: ["checkout-web"], text: "Review the diff" });
  });

  it("shows the commands the template runs on this machine before Start: setup, then the chosen repo's checks", async () => {
    const quickFix = setup.templates.find((t) => t.id === "builtin/quick-fix")!;
    const withSetup = {
      ...setup,
      templates: setup.templates.map((t) => (t === quickFix ? { ...t, setup: "pnpm install", steps: t.steps.map((s, i) => (i === 1 ? { ...s, checks: { from: "repo" } } : s)) } : t)),
    } as Setup;
    await mount({ suggest: null, setup: withSetup });
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    const commands = () => $$(".np-commands code").map((el) => el.textContent);
    expect(commands()).toEqual(["pnpm install", "the repo's checks"]);
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    expect(commands()).toEqual(["pnpm install", "pnpm test"]);
  });

  it("shows a step whose agent comes from the repo, with what it may do, before Start", async () => {
    const shared = {
      ...setup,
      templates: setup.templates.map((t) =>
        t.id === "builtin/quick-fix"
          ? { ...t, id: "orders-api/quick-fix", steps: t.steps.map((step, i) => (i === 0 ? { ...step, agentAccess: { name: "Repo builder", owner: "repo", edit: true, commands: ["curl"], web: true } } : step)) }
          : t,
      ),
    } as Setup;
    await mount({ suggest: null, setup: shared });
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    expect($$(".np-agent").map((el) => el.textContent)).toEqual(["Fix · Repo builder (from repo orders-api) · edits files · runs curl · uses the web"]);
    expect($(".np-steps")?.textContent).toContain("Fix · Repo builder");
    // A repo's template lists only its own repo.
    await click(trigger("Repos"));
    expect(options()).toEqual(["orders-api"]);
  });

  it("shows the template's warnings, and asks for one repo when the template needs one", async () => {
    const warned = { ...setup, templates: setup.templates.map((t) => (t.id === "builtin/quick-fix" ? { ...t, warnings: ["Step Fix cannot run: builder runs on ollama."] } : t)) } as Setup;
    await mount({ suggest: null, setup: warned });
    await focusInput();
    await type(input(), "Fix it");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    expect($(".np-warning")?.textContent).toContain("Step Fix cannot run: builder runs on ollama.");
    expect($(".np-reason")?.textContent).toBe("Choose one repo");
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    await click($$('[role="option"]')[1]);
    expect($(".np-reason")?.textContent).toBe("Choose one repo");
  });

  it("starts with Cmd+Enter from the text field", async () => {
    const fake = await mount();
    await focusInput();
    await type(input(), "5xx on checkout");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Emergency investigator"))!);
    await press(search() ?? input(), "Enter", { metaKey: true });
    expect(fake.command).toHaveBeenCalledWith(expect.objectContaining({ type: "start_item", templateId: "builtin/emergency-investigator", repoIds: [], text: "5xx on checkout" }));
  });

  it("shows an error from start_item inline and keeps the draft", async () => {
    const fake = await mount({ commandReply: { ok: false, error: { code: "invalid_request", message: "a task needs at least one repo <b>now</b>" } } });
    await focusInput();
    await type(input(), "Fix the retry loop");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    await click(start());
    expect(fake.command).toHaveBeenCalledTimes(1);
    expect($('.np-error[role="alert"]')?.textContent).toBe("✕Could not start the work: a task needs at least one repo <b>now</b>");
    expect($(".np-error b")).toBeNull();
    expect(input().value).toBe("Fix the retry loop");
    expect($(".np-body")).not.toBeNull();
    expect($(".drawer")).toBeNull();
    expect(start().disabled).toBe(false);
  });

  it("says when the engine is not connected", async () => {
    await mount({ commandReply: { ok: false, error: { code: "not_connected", message: "x" } } });
    await focusInput();
    await type(input(), "5xx on checkout");
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Emergency investigator"))!);
    await click(start());
    expect($(".np-error")?.textContent).toBe("✕Not connected to the engine. Try again when it is back.");
  });

  it("shows the new item in All work when the current view would hide it", async () => {
    const fake = await mount({ suggest: null });
    await click($$(".sb-main").find((el) => el.querySelector(".ellipsis")?.textContent === "Review only")!);
    expect($("main h1")?.textContent).toBe("Review only");
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Quick fix"))!);
    await type(input(), "Fix the retry loop");
    await click(trigger("Repos"));
    await click($$('[role="option"]')[0]);
    await click(start());
    expect($("main h1")?.textContent).toBe("All work");
    await wait(0);
    await fake.pushItem(newItem);
    expect($('.pl-row[aria-current="true"] .pl-title')?.textContent).toBe("Fix the retry loop");
    expect($(".drawer h2")?.textContent).toBe("Fix the retry loop");
  });

  it("switches the status filter from Done to Active so the new item is not hidden", async () => {
    const fake = await mount({ suggest: null });
    const pressed = () => $$(".filter-bar .segment").filter((el) => el.getAttribute("aria-pressed") === "true").map((el) => el.getAttribute("data-kind"));
    await click($(".filter-bar .segment[data-kind=\"done\"]"));
    expect(pressed()).toEqual(["done"]);
    await focusInput();
    await click(trigger("Template"));
    await click($$('[role="option"]').find((el) => el.textContent?.includes("Emergency investigator"))!);
    await type(input(), "5xx on checkout");
    await click(start());
    expect(fake.command).toHaveBeenCalledTimes(1);
    expect(pressed()).toEqual(["active"]);
  });
});

describe("opening New work", () => {
  const platform = (name: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(name);
  beforeEach(() => platform("MacIntel"));

  it("opens from '+ New work' and focuses the input", async () => {
    await mount();
    await click($(".new-work"));
    expect($(".new-work")?.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement).toBe(input());
    expect($(".np-body")).not.toBeNull();
  });

  it("opens from Cmd+N on macOS, and keeps what was typed; Ctrl+N is not ours there", async () => {
    await mount();
    await press(document.body, "n", { ctrlKey: true });
    expect($(".np-body")).toBeNull();
    await press(document.body, "n", { metaKey: true });
    expect(document.activeElement).toBe(input());
    await type(input(), "draft");
    await press(input(), "Escape");
    await press(document.body, "n", { metaKey: true });
    expect(input().value).toBe("draft");
    expect($(".np-body")).not.toBeNull();
    // Cmd+Shift+N is not ours.
    await press(input(), "Escape");
    await press(document.body, "n", { metaKey: true, shiftKey: true });
    expect($(".np-body")).toBeNull();
  });

  it("opens from Ctrl+N elsewhere, and ignores Cmd+N", async () => {
    platform("Linux x86_64");
    await mount();
    await press(document.body, "n", { metaKey: true });
    expect($(".np-body")).toBeNull();
    await press(document.body, "n", { ctrlKey: true });
    expect(document.activeElement).toBe(input());
  });

  it("opens from Cmd+N with the sidebar closed", async () => {
    await mount();
    await click($('button[aria-label="Sidebar"]'));
    expect($("aside.panel")).toBeNull();
    await press(document.body, "n", { metaKey: true });
    expect(document.activeElement).toBe(input());
  });

  it("opens with the template of a workflow row's '+'", async () => {
    await mount();
    const button = plus("Start Plan and build");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    await click(button);
    expect(trigger("Template").textContent).toBe("TemplatePlan and build▾");
    expect(document.activeElement).toBe(input());
  });

  it("opens with the repo of a repo row's '+'", async () => {
    await mount();
    await click(plus("Quick task in checkout-web"));
    expect(trigger("Repos").textContent).toBe("Reposcheckout-web▾");
    expect(trigger("Template").textContent).toBe("TemplateChoose…▾");
    // The "+" on another row changes only its own field.
    await click(plus("Start Quick fix"));
    expect(trigger("Template").textContent).toBe("TemplateQuick fix▾");
    expect(trigger("Repos").textContent).toBe("Reposcheckout-web▾");
  });
});

describe("Escape and focus", () => {
  it("collapses on Escape and gives focus back to the '+' that opened it", async () => {
    await mount();
    const button = plus("Start Quick fix");
    act(() => button.focus());
    await click(button);
    expect(document.activeElement).toBe(input());
    await press(input(), "Escape");
    expect($(".np-body")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("gives focus back to what had it before a click into the input", async () => {
    await mount();
    const toggle = $('button[aria-label="Sidebar"]') as HTMLElement;
    act(() => toggle.focus());
    await act(async () => input().dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: toggle })));
    await act(async () => {
      input().focus();
    });
    await press(input(), "Escape");
    expect($(".np-body")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("closes an open dropdown first, then collapses on the next Escape", async () => {
    await mount();
    await focusInput();
    await click(trigger("Repos"));
    await press(search(), "Escape");
    expect($('[role="listbox"]')).toBeNull();
    expect($(".np-body")).not.toBeNull();
    expect(document.activeElement).toBe(trigger("Repos"));
    await press(trigger("Repos"), "Escape");
    expect($(".np-body")).toBeNull();
  });

  it("does not close the item drawer when Escape only collapses the input", async () => {
    await mount();
    await click($$(".pl-row")[0]);
    expect($(".drawer")).not.toBeNull();
    await focusInput();
    await press(input(), "Escape");
    expect($(".np-body")).toBeNull();
    expect($(".drawer")).not.toBeNull();
    await press(document.body, "Escape");
    expect($(".drawer")).toBeNull();
  });

  it("closes a dropdown on a click outside it", async () => {
    await mount();
    await focusInput();
    await click(trigger("Repos"));
    await act(async () => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect($('[role="listbox"]')).toBeNull();
  });
});
