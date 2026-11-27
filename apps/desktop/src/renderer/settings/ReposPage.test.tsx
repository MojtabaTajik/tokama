// @vitest-environment happy-dom
import type { ItemRecord, Setup } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { ITEMS, NOW, setup as sampleSetup } from "../testing/sample.js";
import { ReposPage } from "./ReposPage.js";
import { REPO_ITEMS_DELAY_MS } from "./useRepoItems.js";

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

const $ = (selector: string) => document.querySelector(selector);
const $$ = (selector: string) => [...document.querySelectorAll(selector)];
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const buttonByText = (text: string) => $$("button").find((el) => el.textContent === text);
const text = (selector: string) => $(selector)?.textContent ?? "";
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const REPOS = [
  { id: "orders-api", baseBranch: "main", checks: ["pnpm test", "pnpm lint"], path: "~/code/orders-api" },
  { id: "checkout-web", baseBranch: "main", checks: ["pnpm test"], path: "~/code/checkout-web" },
  { id: "inventory-service", baseBranch: "develop", checks: [], path: "~/code/inventory-service" },
];
const withRepos = (repos: readonly object[]) => ({ ...sampleSetup, repos }) as unknown as Setup;

/** A finished or live item of a repo, `minutes` before NOW. */
const inRepo = (base: ItemRecord, repoId: string, id: string, minutes = 0): ItemRecord =>
  ({ ...base, id: `item_00000000-0000-4000-8000-${id.padStart(12, "0")}`, repoIds: [repoId], createdAt: base.createdAt - minutes * 60_000 }) as unknown as ItemRecord;
const ITEMS_OF_REPOS: ItemRecord[] = [
  ITEMS.needsYou, // orders-api, needs you
  ITEMS.verifying, // orders-api, running
  ITEMS.queued, // orders-api, queued: counted nowhere
  inRepo(ITEMS.done, "orders-api", "1", 0), // done today
  inRepo(ITEMS.done, "orders-api", "2", 3 * 24 * 60), // done 3 days ago
  inRepo(ITEMS.done, "orders-api", "3", 10 * 24 * 60), // done 10 days ago: not this week
  ITEMS.working, // checkout-web, running
  ITEMS.failed, // checkout-web, failed today
  inRepo(ITEMS.failed, "checkout-web", "4", 20 * 24 * 60), // failed 20 days ago: no badge
  ITEMS.stock, // inventory-service, running
];

interface Options {
  readonly setup?: Setup;
  readonly connection?: ConnectionState;
  readonly picked?: string | null;
  readonly commandReply?: (command: { type: string }) => Reply;
  readonly boardItems?: ItemRecord[];
}
async function mount(options: Options = {}) {
  const setup = options.setup ?? withRepos(REPOS);
  const fake = fakeBridge(options.connection ?? CONNECTED, {
    boardItems: options.boardItems ?? ITEMS_OF_REPOS,
    pickFolder: async () => (options.picked === undefined ? "/home/dev/code/billing-api" : options.picked),
    reply: (query) =>
      query.type === "suggest_repo"
        ? { ok: true, data: { path: "/home/dev/code/billing-api", displayPath: "~/code/billing-api", gitRepo: true, hasCommits: true, branch: "main", id: "billing-api", checks: ["pnpm test"], checksFrom: ["test"], defaultBranch: "main", branches: [{ name: "main", group: "default" }], moreBranches: 0, fallbackCheck: null, fallbackFromPackage: false, firstCommit: null, problem: null } }
        : query.type === "repo_branches"
          ? { ok: true, data: { defaultBranch: "main", branches: [{ name: "main", group: "default" }, { name: "develop", group: "usual" }], moreBranches: 0 } }
          : undefined,
    commandReply: options.commandReply ?? (() => ({ ok: true, data: null })),
  });
  const connection = options.connection ?? CONNECTED;
  await act(async () => root.render(<ReposPage bridge={fake.bridge} connection={connection} setup={setup} now={NOW} />));
  return fake;
}

const rows = () => $$(".rp-row");
const rowText = (id: string) => rows().find((el) => el.querySelector(".rp-row-id")?.textContent === id)!;
const detail = () => text(".rp-detail");

describe("Settings entries", () => {
  it("lists Repos first under Setup and opens its page", async () => {
    const fake = fakeBridge(CONNECTED, { boardItems: ITEMS_OF_REPOS, reply: (query) => (query.type === "setup" ? { ok: true, data: withRepos(REPOS) } : undefined) });
    await act(async () => root.render(<App bridge={fake.bridge as TokamaBridge} retryDelayMs={10} now={NOW} />));
    await click($$(".rail button").find((el) => /^Settings/.test(el.getAttribute("aria-label") ?? "")));
    const setupGroup = $$('nav[aria-label="Settings"] [role="group"]').find((el) => el.getAttribute("aria-label") === "Setup")!;
    expect([...setupGroup.querySelectorAll(".settings-entry")].map((el) => el.textContent)).toEqual(["Repos", "Templates", "Agents"]);
    await click([...setupGroup.querySelectorAll(".settings-entry")][0]);
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("Repos");
    expect(rows().map((el) => el.querySelector(".rp-row-id")?.textContent)).toEqual(["orders-api", "checkout-web", "inventory-service"]);
  });

  it("loads the list again after a setup change, and the badges after an item update", async () => {
    let current = withRepos(REPOS);
    const fake = fakeBridge(CONNECTED, { boardItems: ITEMS_OF_REPOS, reply: (query) => (query.type === "setup" ? { ok: true, data: current } : undefined) });
    await act(async () => root.render(<App bridge={fake.bridge as TokamaBridge} retryDelayMs={10} now={NOW} />));
    await click($$(".rail button").find((el) => /^Settings/.test(el.getAttribute("aria-label") ?? "")));
    await click($$(".settings-entry").find((el) => el.textContent === "Repos"));
    expect(rows()).toHaveLength(3);
    current = withRepos([...REPOS, { id: "billing-api", baseBranch: "main", checks: ["pnpm test"], path: "~/code/billing-api" }]);
    await fake.pushEvent({ type: "setup_changed" } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await act(async () => undefined);
    expect(rows().map((el) => el.querySelector(".rp-row-id")?.textContent)).toContain("billing-api");
    // A running item is no badge.
    expect(rowText("inventory-service").querySelector(".status-counts")).toBeNull();
    await fake.pushItem({ ...ITEMS.stock, state: "needs_you" });
    await act(async () => new Promise((resolve) => setTimeout(resolve, REPO_ITEMS_DELAY_MS + 20)));
    expect(rowText("inventory-service").textContent).toContain("1 need");
    expect(rowText("inventory-service").textContent).not.toContain("running");
  });
});

describe("Repos page", () => {
  it("lists each repo with its path, base branch, checks and badges, and selects the first", async () => {
    await mount();
    expect(rows().map((el) => [...el.querySelectorAll(":scope > span")].map((line) => line.textContent))).toEqual([
      ["orders-api⏸ 11 needs you", "~/code/orders-api", "main · 2 checks"],
      ["checkout-web✕ 11 failed", "~/code/checkout-web", "main · 1 check"],
      ["inventory-service", "~/code/inventory-service", "develop · no checks"],
    ]);
    expect(rows().map((el) => el.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(rowText("orders-api").querySelector(".status-count")?.hasAttribute("title")).toBe(false);
    expect($(".status-counts")?.textContent).toContain("⏸");
  });

  it("shows the selected repo: items line, path, base branch, numbered checks", async () => {
    await mount();
    expect(text(".rp-head-text h2")).toBe("orders-api");
    expect(text(".rp-head-text p")).toBe("1 needs you · 1 running · 2 done this week");
    expect(detail()).toContain("Path~/code/orders-api");
    expect(detail()).toContain("Base branchWork branches start from it.main");
    expect(detail()).toContain("Checks 2 checksTokama runs these in order after each change. A change passes when every one exits with 0.");
    expect($$(".rp-checks li").map((el) => el.textContent)).toEqual(["1pnpm test", "2pnpm lint"]);
    expect($(".rp-note")).toBeNull();
    expect($$(".rp-actions button").map((el) => el.textContent)).toEqual(["Edit…", "Remove…"]);
    await click(rows()[1]!);
    expect(text(".rp-head-text h2")).toBe("checkout-web");
    expect(text(".rp-head-text p")).toBe("1 failed · 1 running");
    expect(rows().map((el) => el.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  });

  it("explains a repo without checks, and shows no items line when it has no items", async () => {
    await mount({ boardItems: [] });
    await click(rows()[2]!);
    expect(text(".rp-head-text h2")).toBe("inventory-service");
    expect($(".rp-head-text p")).toBeNull();
    expect(detail()).toContain("Checks no checks");
    expect(text(".rp-note")).toBe("Quick fix needs at least one check. Templates where you approve the change, like Quick change, work without checks.");
    expect($(".rp-checks")).toBeNull();
  });

  it("shows a repo without a path with no path line", async () => {
    await mount({ setup: withRepos([{ id: "orders-api", baseBranch: "main", checks: [] }]), boardItems: [] });
    expect(rowText("orders-api").querySelector(".rp-row-path")).toBeNull();
    expect(detail()).not.toContain("Path");
  });

  it("truncates long ids, paths and commands with the full text in a tooltip", async () => {
    const id = "a-very-long-repo-id-".repeat(4);
    const path = `~/${"deep/".repeat(30)}repo`;
    const check = "pnpm test --filter @scope/package -- --reporter=verbose ".repeat(4).trim();
    await mount({ setup: withRepos([{ id, baseBranch: "release/".repeat(8), checks: [check], path }]), boardItems: [] });
    expect($(".rp-row-id")?.getAttribute("title")).toBe(id);
    expect($(".rp-row-path")?.getAttribute("title")).toBe(path);
    expect($(".rp-head-text h2")?.getAttribute("title")).toBe(id);
    expect($(".rp-value")?.getAttribute("title")).toBe(path);
    expect($(".rp-checks .ellipsis")?.getAttribute("title")).toBe(check);
    expect($(".rp-row-id")?.className).toContain("ellipsis");
  });

  it("hides Edit and Remove for sample repos, which the engine cannot change", async () => {
    await mount({ setup: withRepos(REPOS.map((repo) => ({ ...repo, sample: true }))) });
    expect(rows()).toHaveLength(3);
    expect($(".rp-actions")).toBeNull();
  });

  it("shows the empty state, and its button adds a repo like the header's", async () => {
    const fake = await mount({ setup: withRepos([]) });
    expect(rows()).toHaveLength(0);
    expect(text(".rp-empty")).toBe("No repos added yet" + "Add the folders of the repos you work on. Tokama reads each one and suggests the base branch and checks." + "Add repo");
    await click(buttonByText("Add repo"));
    expect(fake.bridge.pickFolder).toHaveBeenCalledTimes(1);
    expect($("dialog.modal")?.getAttribute("aria-labelledby")).not.toBeNull();
    expect(text("dialog.modal h2")).toBe("Add repo");
  });

  it("replaces the page with the engine's state while it is not connected: no list, no buttons", async () => {
    await mount({ connection: { status: "reconnecting", attempt: 1 } as unknown as ConnectionState });
    expect(text(".rp-state")).toBe("Reconnecting to the engine");
    expect(rows()).toHaveLength(0);
    expect(buttonByText("+ Add repo")).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
    const failed: ConnectionState = { status: "failed", reason: "The engine stopped.", logPath: "~/.tokama/engine.log", logTail: [] } as unknown as ConnectionState;
    const fake = await mount({ connection: failed });
    expect(text(".rp-state")).toContain("The engine stopped.");
    expect(rows()).toHaveLength(0);
    await click(buttonByText("Try again"));
    expect(fake.retryConnection).toHaveBeenCalledTimes(1);
  });
});

describe("Add, Edit and Remove", () => {
  it("closes an open dialog when the connection is lost and does not open it again on return", async () => {
    const fake = await mount();
    await click(buttonByText("Edit…"));
    expect($("dialog.modal")).not.toBeNull();
    const render = (connection: ConnectionState) => act(async () => root.render(<ReposPage bridge={fake.bridge} connection={connection} setup={withRepos(REPOS)} now={NOW} />));
    await render({ status: "reconnecting", attempt: 1 } as unknown as ConnectionState);
    expect($("dialog.modal")).toBeNull();
    await render(CONNECTED);
    expect(rows()).toHaveLength(3);
    expect($("dialog.modal")).toBeNull();
  });

  it("adds a repo: the picker, the dialog, then add_repo", async () => {
    const fake = await mount();
    await click(buttonByText("+ Add repo"));
    expect(fake.bridge.pickFolder).toHaveBeenCalledTimes(1);
    await act(async () => undefined);
    expect(text("dialog.modal h2")).toBe("Add repo");
    await click($$("dialog.modal button").find((el) => el.textContent === "Add repo"));
    expect(fake.command).toHaveBeenCalledWith({ type: "add_repo", path: "/home/dev/code/billing-api", id: "billing-api", baseBranch: "main", checks: ["pnpm test"] });
    expect($("dialog.modal")).toBeNull();
  });

  it("does nothing when the picker is cancelled", async () => {
    await mount({ picked: null });
    await click(buttonByText("+ Add repo"));
    expect($("dialog.modal")).toBeNull();
  });

  it("edits the selected repo with update_repo (base branch and checks)", async () => {
    const fake = await mount();
    await click(rows()[1]!);
    await click(buttonByText("Edit…"));
    expect(text("dialog.modal h2")).toBe("Edit repo");
    const checks = $("dialog.modal textarea") as HTMLTextAreaElement;
    expect(checks.value).toBe("pnpm test");
    await type(checks, "pnpm test\npnpm lint");
    await click($$("dialog.modal button").find((el) => el.textContent === "Save"));
    expect(fake.command).toHaveBeenCalledWith({ type: "update_repo", repoId: "checkout-web", baseBranch: "main", checks: ["pnpm test", "pnpm lint"] });
    expect($("dialog.modal")).toBeNull();
  });

  it("removes the selected repo after the confirmation, naming the items that wait for you, and selects the next repo", async () => {
    const fake = await mount();
    await click(buttonByText("Remove…"));
    expect(text("dialog.modal h2")).toBe("Remove orders-api?");
    expect(text("dialog.modal")).toContain("1 item waits for you in it.");
    expect(fake.command).not.toHaveBeenCalled();
    await click(buttonByText("Remove repo"));
    expect(fake.command).toHaveBeenCalledWith({ type: "remove_repo", repoId: "orders-api" });
    expect($("dialog.modal")).toBeNull();
    expect(text(".rp-head-text h2")).toBe("checkout-web");
  });

  it("keeps the repo when the question is answered with Keep, and shows the engine's refusal", async () => {
    const refusal = { ok: false as const, error: { code: "not_found", message: "No repo has the id 'orders-api'." } };
    const fake = await mount({ commandReply: () => refusal });
    await click(buttonByText("Remove…"));
    await click(buttonByText("Keep"));
    expect($("dialog.modal")).toBeNull();
    expect(fake.command).not.toHaveBeenCalled();
    await click(buttonByText("Remove…"));
    await click(buttonByText("Remove repo"));
    expect($('dialog.modal [role="alert"]')?.textContent).toBe("✕ Could not remove it: No repo has the id 'orders-api'.");
    expect(rows()).toHaveLength(3);
  });

  it("shows the empty state after the last repo is gone, with the focus on + Add repo", async () => {
    const only = withRepos([REPOS[0]!]);
    const fake = fakeBridge(CONNECTED, { boardItems: [], commandReply: () => ({ ok: true, data: null }) });
    const render = (setup: Setup) => act(async () => root.render(<ReposPage bridge={fake.bridge} connection={CONNECTED} setup={setup} now={NOW} />));
    await render(only);
    await click(buttonByText("Remove…"));
    await click(buttonByText("Remove repo"));
    await render(withRepos([]));
    expect(text(".rp-empty .empty-state-title")).toBe("No repos added yet");
    expect(document.activeElement?.textContent).toBe("+ Add repo");
  });
});
