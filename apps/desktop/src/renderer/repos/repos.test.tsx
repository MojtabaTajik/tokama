// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const FOLDER = "/home/dev/code/billing-api";
const SUGGESTION = { path: FOLDER, gitRepo: true, hasCommits: true, branch: "main", id: "billing-api", checks: ["pnpm test", "pnpm lint"], fallbackCheck: null, problem: null };

async function mountWith(options: { suggestion?: Reply; picked?: string | null; commandReply?: (command: { type: string }) => Reply; setup?: () => Reply | undefined } = {}) {
  const fake = fakeBridge(CONNECTED, {
    pickFolder: async () => (options.picked === undefined ? FOLDER : options.picked),
    reply: (query) => (query.type === "suggest_repo" ? (options.suggestion ?? { ok: true, data: SUGGESTION }) : query.type === "setup" ? options.setup?.() : undefined),
    commandReply: options.commandReply ?? (() => ({ ok: true, data: null })),
  });
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} />));
  return fake;
}

const $ = (selector: string) => document.querySelector(selector);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const buttonByText = (text: string) => [...document.querySelectorAll("button")].find((el) => el.textContent === text);
const field = (label: string) => {
  const labelEl = [...document.querySelectorAll(".repo-field label")].find((el) => el.textContent === label);
  return document.getElementById(labelEl?.getAttribute("for") ?? "") as HTMLInputElement | HTMLTextAreaElement;
};
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const menuItem = (name: string) => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === name);
const key = (el: Element | null, name: string) => act(async () => void el?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));

describe("+ Add repo", () => {
  it("picks a folder, shows the suggestions as fields, and adds what the user edited", async () => {
    const fake = await mountWith();
    await click(buttonByText("+ Add repo"));
    expect(fake.bridge.pickFolder).toHaveBeenCalledOnce();
    expect(fake.query).toHaveBeenCalledWith({ type: "suggest_repo", path: FOLDER });
    expect($("dialog.modal h2")?.textContent).toBe("Add repo");
    expect($("dialog.modal .repo-path")?.textContent).toBe(FOLDER);
    expect(field("Id").value).toBe("billing-api");
    expect(document.activeElement).toBe(field("Id"));
    expect(field("Base branch").value).toBe("main");
    expect(field("Checks").value).toBe("pnpm test\npnpm lint");

    await type(field("Id"), "billing");
    await type(field("Checks"), "pnpm test\n\n");
    await click(buttonByText("Add repo"));
    expect(fake.command).toHaveBeenCalledWith({ type: "add_repo", path: FOLDER, id: "billing", baseBranch: "main", checks: ["pnpm test"] });
    expect($("dialog.modal")).toBeNull();
  });

  it("loads the setup again when the engine says it changed", async () => {
    const fake = await mountWith();
    const setupQueries = () => fake.query.mock.calls.filter(([query]) => (query as { type: string }).type === "setup").length;
    const before = setupQueries();
    await fake.pushEvent({ type: "setup_changed" });
    expect(setupQueries()).toBe(before + 1);
  });

  it("opens nothing when the picker is cancelled", async () => {
    const fake = await mountWith({ picked: null });
    await click(buttonByText("+ Add repo"));
    expect(fake.query).not.toHaveBeenCalledWith(expect.objectContaining({ type: "suggest_repo" }));
    expect($("dialog.modal")).toBeNull();
  });

  it("shows why a folder can't be added, and offers no Add", async () => {
    await mountWith({ suggestion: { ok: true, data: { ...SUGGESTION, gitRepo: false, branch: null, checks: [], problem: "This folder isn't a git repo." } } });
    await click(buttonByText("+ Add repo"));
    expect($(".repo-problem")?.textContent).toBe("✕ This folder isn't a git repo.");
    expect(document.querySelector(".repo-field")).toBeNull();
    expect((buttonByText("Add repo") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open with the engine's words when it refuses", async () => {
    const fake = await mountWith({ commandReply: () => ({ ok: false, error: { code: "invalid_request", message: "The check 'pnpm a && b' must be one command, with no &&, ||, ; or |." } }) });
    await click(buttonByText("+ Add repo"));
    await click(buttonByText("Add repo"));
    expect(fake.command).toHaveBeenCalledOnce();
    expect($('[role="alert"]')?.textContent).toBe("✕ Could not add it: The check 'pnpm a && b' must be one command, with no &&, ||, ; or |.");
    expect($("dialog.modal")).not.toBeNull();
  });

  it("renders engine text as text, never as markup", async () => {
    await mountWith({ suggestion: { ok: true, data: { ...SUGGESTION, path: "/x/<img src=x onerror=alert(1)>", problem: "<b>bad</b>" } } });
    await click(buttonByText("+ Add repo"));
    expect($(".repo-path")?.textContent).toBe("/x/<img src=x onerror=alert(1)>");
    expect($("dialog img, dialog b")).toBeNull();
  });

  it("closes with Escape and with Cancel", async () => {
    await mountWith();
    await click(buttonByText("+ Add repo"));
    await key(field("Id"), "Escape");
    expect($("dialog.modal")).toBeNull();
    await click(buttonByText("+ Add repo"));
    await click(buttonByText("Cancel"));
    expect($("dialog.modal")).toBeNull();
  });
});

describe("Add repo warnings", () => {
  const NO_COMMITS = "This repo has no commits yet. Make a first commit, then add it.";

  it("says a repo has no commits and keeps Add off", async () => {
    const fake = await mountWith({ suggestion: { ok: true, data: { ...SUGGESTION, hasCommits: false, problem: NO_COMMITS } } });
    await click(buttonByText("+ Add repo"));
    expect($(".repo-problem")?.textContent).toBe(`✕ ${NO_COMMITS}`);
    expect($(".repo-field")).toBeNull();
    const add = buttonByText("Add repo") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await click(add);
    expect(fake.command).not.toHaveBeenCalled();
  });

  it("explains checks when none are found, and offers the fallback that fills them in", async () => {
    const fake = await mountWith({ suggestion: { ok: true, data: { ...SUGGESTION, checks: [], fallbackCheck: "node --check src/main.js" } } });
    await click(buttonByText("+ Add repo"));
    const note = $(".repo-note")?.textContent ?? "";
    expect(note).toContain("No checks yet.");
    expect(note).toContain("Quick fix and Plan and build need at least one");
    expect(note).toContain("templates where you approve the change work without checks");
    expect(note).toContain("This folder has no package.json");
    expect(note).toContain("node --check src/main.js");
    await click(buttonByText("Use node --check src/main.js"));
    expect(field("Checks").value).toBe("node --check src/main.js");
    expect($(".repo-note")).toBeNull();
    await click(buttonByText("Add repo"));
    expect(fake.command).toHaveBeenCalledWith(expect.objectContaining({ type: "add_repo", checks: ["node --check src/main.js"] }));
  });

  it("explains checks without a fallback button when none fits, and not when checks are set", async () => {
    await mountWith({ suggestion: { ok: true, data: { ...SUGGESTION, checks: [] } } });
    await click(buttonByText("+ Add repo"));
    expect($(".repo-note")?.textContent).toContain("No checks yet.");
    expect($(".repo-note button")).toBeNull();
    await type(field("Checks"), "make test");
    expect($(".repo-note")).toBeNull();
  });

  it("shows no note when checks were found", async () => {
    await mountWith();
    await click(buttonByText("+ Add repo"));
    expect($(".repo-note")).toBeNull();
  });
});

describe("Edit repo", () => {
  const menuButton = () => $('button[aria-label="Actions for orders-api"]') as HTMLButtonElement;
  const openEdit = async () => {
    await click(menuButton());
    await click(menuItem("Edit repo…"));
  };
  const orders = setup.repos.find((repo) => repo.id === "orders-api")!;

  it("opens the dialog pre-filled with the id read-only, and saves the base branch and checks", async () => {
    const fake = await mountWith();
    await openEdit();
    expect($('[role="menu"]')).toBeNull();
    expect($("dialog.modal h2")?.textContent).toBe("Edit repo");
    expect(fake.query).not.toHaveBeenCalledWith(expect.objectContaining({ type: "suggest_repo" }));
    expect(field("Id").value).toBe("orders-api");
    expect(field("Id").readOnly).toBe(true);
    expect(field("Base branch").value).toBe(orders.baseBranch);
    expect(field("Checks").value).toBe(orders.checks.join("\n"));
    expect(document.activeElement).toBe(field("Base branch"));

    await type(field("Base branch"), " develop ");
    await type(field("Checks"), "pnpm test\n\npnpm lint");
    await click(buttonByText("Save"));
    expect(fake.command).toHaveBeenCalledWith({ type: "update_repo", repoId: "orders-api", baseBranch: "develop", checks: ["pnpm test", "pnpm lint"] });
    expect($("dialog.modal")).toBeNull();
  });

  it("keeps the dialog open with the engine's words when it refuses", async () => {
    await mountWith({ commandReply: () => ({ ok: false, error: { code: "invalid_request", message: "The base branch 'a b' must be a branch name, such as main." } }) });
    await openEdit();
    await click(buttonByText("Save"));
    expect($('[role="alert"]')?.textContent).toBe("✕ Could not save it: The base branch 'a b' must be a branch name, such as main.");
    expect($("dialog.modal")).not.toBeNull();
  });

  it("explains checks when the repo has none, without a fallback button", async () => {
    await mountWith({ setup: () => ({ ok: true, data: { ...setup, repos: setup.repos.map((repo) => (repo.id === "orders-api" ? { ...repo, checks: [] } : repo)) } }) });
    await openEdit();
    expect($(".repo-note")?.textContent).toContain("No checks yet.");
    expect($(".repo-note button")).toBeNull();
  });

  it("closes with Cancel and sends nothing", async () => {
    const fake = await mountWith();
    await openEdit();
    await click(buttonByText("Cancel"));
    expect($("dialog.modal")).toBeNull();
    expect(fake.command).not.toHaveBeenCalled();
  });
});

describe("repo row menu", () => {
  const menuButton = () => $('button[aria-label="Actions for orders-api"]') as HTMLButtonElement;

  it("opens with the keyboard, confirms in the app, then removes the repo", async () => {
    const fake = await mountWith();
    await key(menuButton(), "ArrowDown");
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(menuItem("Edit repo…"));
    await key(menuItem("Edit repo…") ?? null, "ArrowDown");
    expect(document.activeElement).toBe(menuItem("Remove repo…"));
    await key(menuItem("Remove repo…") ?? null, "ArrowDown");
    expect(document.activeElement).toBe(menuItem("Edit repo…"));
    await key(menuItem("Edit repo…") ?? null, "ArrowUp");
    const item = menuItem("Remove repo…");

    await click(item);
    expect($('[role="menu"]')).toBeNull();
    expect($("dialog.modal h2")?.textContent).toBe("Remove orders-api?");
    expect($("dialog.modal p")?.textContent).toContain("Its items and worktrees are kept");
    // The safe choice has focus.
    expect(document.activeElement?.textContent).toBe("Keep");

    await click(buttonByText("Remove repo"));
    expect(fake.command).toHaveBeenCalledWith({ type: "remove_repo", repoId: "orders-api" });
    expect($("dialog.modal")).toBeNull();
  });

  it("moves focus to + Add repo once the removed repo's row is gone", async () => {
    let removed = false;
    const fake = await mountWith({ setup: () => (removed ? { ok: true, data: { ...setup, repos: setup.repos.filter((repo) => repo.id !== "orders-api") } } : undefined) });
    await click(menuButton());
    await click(menuItem("Remove repo…"));
    await click(buttonByText("Remove repo"));
    removed = true;
    await fake.pushEvent({ type: "setup_changed" });
    expect(menuButton()).toBeNull();
    expect(document.activeElement).toBe(buttonByText("+ Add repo"));
  });

  it("offers no menu on a sample repo, which isn't in repos.yaml", async () => {
    await mountWith({ setup: () => ({ ok: true, data: { ...setup, repos: setup.repos.map((repo) => (repo.id === "orders-api" ? { ...repo, sample: true } : repo)) } }) });
    expect(menuButton()).toBeNull();
    expect($('button[aria-label="Actions for checkout-web"]')).not.toBeNull();
  });

  it("keeps the repo when Keep or Escape is chosen, and shows a refusal", async () => {
    const fake = await mountWith({ commandReply: () => ({ ok: false, error: { code: "not_found", message: "No repo has the id 'orders-api'." } }) });
    await click(menuButton());
    await click(menuItem("Remove repo…"));
    await click(buttonByText("Keep"));
    expect($("dialog.modal")).toBeNull();
    expect(fake.command).not.toHaveBeenCalled();

    await click(menuButton());
    await key(menuItem("Remove repo…") ?? null, "Escape");
    expect($('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton());

    await click(menuButton());
    await click(menuItem("Remove repo…"));
    await click(buttonByText("Remove repo"));
    expect($('[role="alert"]')?.textContent).toBe("✕ Could not remove it: No repo has the id 'orders-api'.");
  });
});
