// @vitest-environment happy-dom
// The agent label and its tooltip inside the app: on list rows and in the drawer, next to the row's
// own button, and the link to the agent in Settings.
import type { AgentsListResult, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
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

const ACCESS: Record<string, unknown> = {
  architect: { name: "Architect", owner: "builtin", cliId: "claude-code", model: "opus", role: "You plan the change.", edit: false, commands: [], web: false },
  "local-builder": { name: "Local builder", owner: "repo", repoId: "orders-api", cliId: "claude-code", model: "qwen3-coder:30b", role: "You build in orders-api.", edit: true, commands: ["pnpm test", "docker compose up"], web: true },
};
/** The sample setup where each step's agent carries what the engine resolved for it. */
const withAccess = {
  ...setup,
  templates: setup.templates.map((template) => ({ ...template, steps: template.steps.map((step) => (step.agentId !== undefined && ACCESS[step.agentId] !== undefined ? { ...step, agentAccess: ACCESS[step.agentId] } : step)) })),
} as unknown as Setup;

const LIST = {
  agents: [
    { id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud", limits: { edit: false, commands: [], web: false }, role: "You plan.", roleCut: false, replacesBuiltin: false, owner: { kind: "builtin" }, source: "builtin/architect.md" },
    { id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local", limits: { edit: true, commands: [], web: false }, role: "You build.", roleCut: false, replacesBuiltin: false, owner: { kind: "repo", repoId: "orders-api" }, source: "orders-api/.tokama/agents/local-builder.md" },
  ],
  broken: [],
  problems: [],
} as unknown as AgentsListResult;

const mount = async () => {
  const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "setup" ? { ok: true, data: withAccess } : query.type === "agents_list" ? { ok: true, data: LIST } : undefined) });
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} />));
  return fake;
};
const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const focus = (el: Element | null | undefined) => act(async () => (el as HTMLElement).focus());
const escape = () => act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
const wrapOf = (title: string) => $$(".pl-row-wrap").find((wrap) => wrap.querySelector(".pl-title")?.textContent === title)!;
const CHECKOUT = "Checkout p95 latency spike";

describe("agent label on a list row", () => {
  it("shows the agent with its model and the current step with its attempt", async () => {
    await mount();
    const wrap = wrapOf(CHECKOUT);
    expect(wrap.querySelector(".pl-agent")?.textContent).toBe("Local builder · qwen3-coder:30b");
    expect(wrap.querySelector(".pl-pipe")?.textContent).toBe("✓●Query logs· attempt 1○");
    expect(wrap.querySelector(".pl-pipe")?.getAttribute("aria-label")).toBe("Steps: Triage passed, Query logs running attempt 1, Propose a fix pending");
  });

  it("keeps the label out of the row's button, so no button holds another", async () => {
    await mount();
    expect($$(".pl-row button, .pl-row [tabindex]")).toEqual([]);
    expect($$(".pl-row-wrap").every((wrap) => wrap.querySelector(":scope > .pl-row") !== null)).toBe(true);
  });

  it("names a step that Tokama runs itself in plain text, with no tooltip", async () => {
    await mount();
    const wrap = wrapOf("Fix rounding in invoice totals");
    // The item is in its checks step: no agent runs it.
    expect(wrap.querySelector(".pl-agent")?.textContent).toBe("Tokama");
    expect(wrap.querySelector(".pl-agent button")).toBeNull();
  });

  it("does not open the item when the label is clicked, and does when the rest of the row is", async () => {
    await mount();
    const wrap = wrapOf(CHECKOUT);
    await click(wrap.querySelector(".al-button"));
    expect($(".drawer")).toBeNull();
    expect($('.pl-row[aria-current="true"]')).toBeNull();
    await click(wrap.querySelector(".pl-row"));
    expect($('.pl-row[aria-current="true"]')).not.toBeNull();
    expect($(".drawer")).not.toBeNull();
  });

  it("opens the tooltip on keyboard focus: owner, model, what the agent may do, its role and the link", async () => {
    await mount();
    await focus(wrapOf(CHECKOUT).querySelector(".al-button"));
    const tip = $('[role="tooltip"]')!;
    expect(tip.querySelector(".al-owner")?.textContent).toBe("repo orders-api");
    expect(tip.querySelector(".al-run")?.textContent).toBe("CCqwen3-coder:30b");
    expect([...tip.querySelectorAll(".al-can")].map((el) => [el.textContent, el.hasAttribute("data-extra")])).toEqual([
      ["edits files", false],
      ["runs: pnpm test, docker compose up", true],
      ["web: on", true],
    ]);
    expect(tip.querySelector(".al-role")?.textContent).toBe("“You build in orders-api.”");
    expect(tip.querySelector(".al-open")?.textContent).toBe("Open in Settings →");
  });

  it("opens Settings on the Agents page with the agent the tooltip names selected", async () => {
    const fake = await mount();
    await focus(wrapOf(CHECKOUT).querySelector(".al-button"));
    await click($(".al-open"));
    expect($("nav.rail")).toBeNull();
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("Agents");
    expect(fake.query).toHaveBeenCalledWith({ type: "agents_list" });
    expect($$(".agent-row").map((row) => [row.querySelector(".agent-row-name")?.textContent, row.getAttribute("aria-pressed")])).toEqual([
      ["Architect", "false"],
      ["Local builder", "true"],
    ]);
    expect($(".agent-detail article")?.getAttribute("aria-label")).toBe("Local builder");
  });
});

describe("agent label in the drawer", () => {
  const openDrawer = async () => {
    await mount();
    await click(wrapOf(CHECKOUT).querySelector(".pl-row"));
    await act(async () => undefined);
  };

  it("shows each step's agent with its model and the same tooltip", async () => {
    await openDrawer();
    expect($$(".step-where").map((el) => el.textContent)).toEqual([
      "Local builder · qwen3-coder:30b · local",
      "Local builder · qwen3-coder:30b · local",
      "Architect · opus · cloud",
    ]);
    await focus($$(".step-where .al-button")[2]);
    expect($('[role="tooltip"] .al-owner')?.textContent).toBe("built-in");
    expect($('[role="tooltip"] .al-may')?.textContent).toContain("reads files only");
  });

  it("closes only the tooltip on the first Escape, and the drawer on the next", async () => {
    await openDrawer();
    await focus($$(".step-where .al-button")[0]);
    expect($('[role="tooltip"]')).not.toBeNull();
    await escape();
    expect($('[role="tooltip"]')).toBeNull();
    expect($(".drawer")).not.toBeNull();
    await escape();
    expect($(".drawer")).toBeNull();
  });
});
