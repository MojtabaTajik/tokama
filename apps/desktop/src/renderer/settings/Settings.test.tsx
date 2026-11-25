// @vitest-environment happy-dom
import type { AgentsListResult } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TokamaBridge } from "../../shared/bridge.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { NOW, setup } from "../testing/sample.js";

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

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const render = (bridge: TokamaBridge) => act(async () => root.render(<App bridge={bridge} retryDelayMs={10} now={NOW} />));
const railButton = (label: RegExp) => $$(".rail button").find((button) => label.test(button.getAttribute("aria-label") ?? ""))!;
const rowNames = () => $$(".agent-row-name").map((el) => el.textContent);
const row = (name: string) => $$(".agent-row").find((el) => el.querySelector(".agent-row-name")?.textContent?.includes(name))!;
const type = (input: Element, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const LIST = {
  agents: [
    { id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud", limits: { edit: false, commands: [], web: false }, icon: "sitemap", role: "Plan the change.", roleCut: false, replacesBuiltin: false, owner: { kind: "builtin" }, source: "builtin/architect.md" },
    { id: "builder", name: "Builder", cliId: "claude-code", model: "sonnet", runsOn: "cloud", limits: { edit: true, commands: [], web: false }, role: "Build it.", roleCut: false, replacesBuiltin: false, owner: { kind: "builtin" }, source: "builtin/builder.md" },
    { id: "reviewer", name: "Reviewer", cliId: "codex-cli", model: "gpt-5", runsOn: "cloud", limits: { edit: false, commands: ["git diff"], web: true }, role: "Review <b>strictly</b>.\nSecond line.", roleCut: true, replacesBuiltin: true, owner: { kind: "personal" }, source: "agents/reviewer.md" },
    { id: "local", name: "Local investigator", cliId: "ollama", drivenBy: "claude-code", model: "qwen3-coder:30b", runsOn: "local", limits: { edit: false, commands: [], web: false }, role: "Look.", roleCut: false, replacesBuiltin: false, owner: { kind: "repo", repoId: "orders-api" }, source: "orders-api/.tokama/agents/local.md" },
  ],
  broken: [{ id: "scribe", owner: { kind: "personal" }, source: "agents/scribe.md", replacesBuiltin: false, problems: ["agents/scribe.md line 4: runs_on 'claud-code' isn't known. Did you mean claude-code?"] }],
  problems: ["agents/Bad Name.md: \"Bad Name\" isn't a valid agent id: use lowercase letters, digits and hyphens (at most 64)"],
} as unknown as AgentsListResult;

const withAgents = (reply: (n: number) => Reply = () => ({ ok: true, data: LIST })) => {
  let calls = 0;
  // A new setup object on every load, as the bridge delivers it.
  const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "agents_list" ? reply(++calls) : query.type === "setup" ? { ok: true, data: structuredClone(setup) } : undefined) });
  return { ...fake, calls: () => calls };
};

const open = async (fake: { bridge: TokamaBridge }) => {
  await render(fake.bridge);
  await click(railButton(/^Settings/));
};
const back = () => click($$("nav button").find((el) => el.textContent === "← Back"));

describe("Settings > Agents", () => {
  it("opens from the rail in place of the rail and the sidebar, with Agents as the current page and a text monogram per agent", async () => {
    const fake = withAgents();
    await open(fake);
    expect($("nav.rail")).toBeNull();
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("Agents");
    expect(rowNames()).toEqual(["Architect", "Builder", "Reviewer", "Local investigator", "✕ brokenscribe"]);
    expect($$(".agent-row-line").map((el) => el.textContent)).toEqual([
      "CC · opus · cloud",
      "CC · sonnet · cloud",
      "CX · gpt-5 · cloud · replaces built-in",
      "OL · qwen3-coder:30b · this machine · via CC",
      "agents/scribe.md",
    ]);
    expect(fake.query).toHaveBeenCalledWith({ type: "agents_list" });
    expect($(".agents img, .agents svg image")).toBeNull();
  });

  it("lists only the pages that work, by group, with no disabled entries", async () => {
    await open(withAgents());
    const nav = $('nav[aria-label="Settings"]')!;
    expect($$('nav[aria-label="Settings"] [role="group"]').map((group) => [group.getAttribute("aria-label"), [...group.querySelectorAll("button")].map((el) => el.textContent)])).toEqual([
      ["Personal", ["Notifications", "Diagnostics"]],
      ["Setup", ["Repos", "Templates", "Agents"]],
      ["Engine", ["AI CLIs"]],
    ]);
    expect(nav.querySelector('[aria-disabled="true"]')).toBeNull();
  });

  it("shows a decorative icon before the label of every nav entry, and the label is the name", async () => {
    await open(withAgents());
    const entries = $$("nav[aria-label='Settings'] .settings-entry");
    expect(entries.map((el) => el.textContent)).toEqual(["Notifications", "Diagnostics", "Repos", "Templates", "Agents", "AI CLIs"]);
    for (const entry of entries) {
      const icon = entry.firstElementChild!;
      expect(icon.tagName.toLowerCase()).toBe("svg");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(entry.querySelectorAll("svg")).toHaveLength(1);
    }
    // Each entry has its own drawing.
    expect(new Set(entries.map((el) => el.querySelector("svg")!.innerHTML)).size).toBe(entries.length);
  });

  it("shows the first agent's role, runs on, model, limits and source, and another one when picked", async () => {
    await open(withAgents());
    const detail = () => $(".agent-detail")!.textContent ?? "";
    expect($(".agent-head-text h2")?.textContent).toBe("Architect");
    expect(detail()).toContain("builtin/architect.md");
    expect(detail()).toContain("Plan the change.");
    expect(detail()).toContain("Read-only");
    expect(detail()).toContain("Built-in");

    await click(row("Reviewer"));
    expect($$(".agent-row").find((el) => el.getAttribute("aria-pressed") === "true")?.textContent).toContain("Reviewer");
    expect($(".agent-head-text h2")?.textContent).toBe("Reviewer");
    expect($(".monogram")?.textContent).toBe("CX");
    expect(detail()).toContain("Codex CLI");
    expect(detail()).toContain("gpt-5");
    expect(detail()).toContain("May run: git diff");
    expect(detail()).toContain("May search and fetch from the web.");
    expect(detail()).toContain("Your plan at the provider (cloud)");
    expect(detail()).toContain("Personal, replaces the built-in");
    expect(detail()).toContain("agents/reviewer.md");
    expect(detail()).toContain("The role is longer; only the start is shown.");

    await click(row("Local investigator"));
    expect(detail()).toContain("Ollama, driven by Claude Code");
    expect(detail()).toContain("This machine; nothing leaves it");
    expect(detail()).toContain("Shared in orders-api");
  });

  it("renders the role as text, never as HTML", async () => {
    await open(withAgents());
    await click(row("Reviewer"));
    expect($(".agent-role")?.textContent).toBe("Review <b>strictly</b>.\nSecond line.");
    expect($(".agent-role b")).toBeNull();
  });

  it("shows a broken file with its problems, marked with a symbol and a word, and the other problems", async () => {
    await open(withAgents());
    expect(row("scribe").textContent).toContain("✕ broken");
    expect($(".agents-problems")?.textContent).toContain("Files that did not load");
    expect($(".agents-problems")?.textContent).toContain("Bad Name");
    await click(row("scribe"));
    expect($(".agent-head-text h2")?.textContent).toBe("scribe");
    expect($(".agent-broken-title")?.textContent).toBe("✕This file does not load");
    expect($$(".agent-problems li").map((el) => el.textContent)).toEqual(["agents/scribe.md line 4: runs_on 'claud-code' isn't known. Did you mean claude-code?"]);
    expect($(".agent-detail")?.textContent).toContain("agents/scribe.md");
  });

  it("filters the list, says when nothing matches, and offers no edit controls", async () => {
    await open(withAgents());
    const filter = $('input[aria-label="Filter agents"]')!;
    await type(filter, "opus");
    expect(rowNames()).toEqual(["Architect"]);
    await type(filter, "nothing like this");
    expect(rowNames()).toEqual([]);
    expect($(".agents-list-pane .placeholder")?.textContent).toBe("No agent matches");
    expect($(".agent-detail .placeholder")?.textContent).toBe("Select an agent");
    expect($$(".agent-detail input, .agent-detail textarea, .agent-detail select")).toEqual([]);
    expect($$(".agents button").map((el) => el.textContent)).not.toContain("Save");
  });

  it("says when there are no agents at all", async () => {
    await open(withAgents(() => ({ ok: true, data: { agents: [], broken: [], problems: [] } })));
    expect($(".agents-list-pane .placeholder")?.textContent).toBe("No agents");
  });

  it("shows a failed load with Retry, and loads again", async () => {
    const fake = withAgents((n) => (n === 1 ? { ok: false, error: { code: "internal", message: "the engine failed" } } : { ok: true, data: LIST }));
    await open(fake);
    expect($(".failure")?.textContent).toContain("Could not load the agents");
    expect($(".failure .detail")?.textContent).toBe("the engine failed");
    await click($(".failure .retry"));
    expect(fake.calls()).toBe(2);
    expect($(".failure")).toBeNull();
    expect(rowNames()).toHaveLength(5);
  });

  it("reads the agents again after a setup change", async () => {
    const fake = withAgents();
    await open(fake);
    expect(fake.calls()).toBe(1);
    await fake.pushEvent({ type: "setup_changed" });
    expect(fake.calls()).toBe(2);
  });

  it("goes back to the board with Back", async () => {
    await open(withAgents());
    await back();
    expect($(".settings")).toBeNull();
    expect($("nav.rail")).not.toBeNull();
  });
});
