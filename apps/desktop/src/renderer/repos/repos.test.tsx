// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { needsYouCount } from "../model.js";
import { items, NOW, setup } from "../testing/sample.js";

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
const SUGGESTION = {
  path: FOLDER,
  displayPath: "~/code/billing-api",
  gitRepo: true,
  hasCommits: true,
  branch: "main",
  id: "billing-api",
  checks: ["pnpm test", "pnpm lint"],
  checksFrom: ["test", "lint"],
  branches: ["main", "develop"],
  fallbackCheck: null,
  fallbackFromPackage: false,
  firstCommit: null,
  problem: null,
};

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
  const labelEl = [...document.querySelectorAll(".repo-field label")].find((el) => el.textContent?.startsWith(label));
  return document.getElementById(labelEl?.getAttribute("for") ?? "") as HTMLInputElement | HTMLTextAreaElement;
};
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const menuItem = (name: string) => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.startsWith(name));
const key = (el: Element | null, name: string) => act(async () => void el?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));

describe("+ Add repo", () => {
  it("picks a folder, shows the suggestions as fields with where they come from, and adds what the user edited", async () => {
    const fake = await mountWith();
    await click(buttonByText("+ Add repo"));
    expect(fake.bridge.pickFolder).toHaveBeenCalledOnce();
    expect(fake.query).toHaveBeenCalledWith({ type: "suggest_repo", path: FOLDER });
    expect($("dialog.modal h2")?.textContent).toBe("Add repo");
    expect($(".dlg-sub")?.textContent).toBe("~/code/billing-api");
    expect(field("Id").value).toBe("billing-api");
    expect(field("Id").placeholder).toBe("orders-api");
    expect(document.activeElement).toBe(field("Id"));
    expect(field("Base branch").value).toBe("main");
    expect(field("Base branch").placeholder).toBe("main");
    expect(field("Checks").value).toBe("pnpm test\npnpm lint");
    expect(field("Checks").placeholder).toBe("npm test\nnode --check src/main.js");
    const text = $("dialog.modal")?.textContent ?? "";
    expect(text).toContain("From the folder name.");
    expect(text).toContain("Found: main (current), develop.");
    expect(text).toContain("✓ suggested");
    expect(text).toContain("Found in package.json scripts: test, lint.");

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
    await mountWith({ suggestion: { ok: true, data: { ...SUGGESTION, gitRepo: false, branch: null, checks: [], problem: "This folder is inside a git repo. Pick the repo's top folder." } } });
    await click(buttonByText("+ Add repo"));
    expect($(".repo-problem")?.textContent).toBe("✕ This folder is inside a git repo. Pick the repo's top folder.");
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
    await mountWith({ suggestion: { ok: true, data: { ...SUGGESTION, displayPath: "/x/<img src=x onerror=alert(1)>", branches: ["<b>main</b>"] } } });
    await click(buttonByText("+ Add repo"));
    expect($(".dlg-sub")?.textContent).toBe("/x/<img src=x onerror=alert(1)>");
    expect($("dialog img, dialog b")).toBeNull();
  });

  it("closes with Escape, with the ✕ and with Cancel", async () => {
    await mountWith();
    await click(buttonByText("+ Add repo"));
    await key(field("Id"), "Escape");
    expect($("dialog.modal")).toBeNull();
    await click(buttonByText("+ Add repo"));
    await click($('button[aria-label="Close"]'));
    expect($("dialog.modal")).toBeNull();
    await click(buttonByText("+ Add repo"));
    await click(buttonByText("Cancel"));
    expect($("dialog.modal")).toBeNull();
  });
});

describe("Add repo warnings", () => {
  const NONE = { ...SUGGESTION, checks: [], checksFrom: [], branches: ["main"] };

  it("explains checks when none are found, and offers the fallback that fills them in", async () => {
    const fake = await mountWith({ suggestion: { ok: true, data: { ...NONE, fallbackCheck: "node --check src/main.js", fallbackFromPackage: true } } });
    await click(buttonByText("+ Add repo"));
    const text = $("dialog.modal")?.textContent ?? "";
    expect(text).toContain("none found");
    expect($(".repo-note")?.textContent).toContain("No checks found in this folder.");
    expect($(".repo-note")?.textContent).toContain("Tokama runs these after each change. Quick fix needs at least one. Templates where you approve the change, like Quick change, work without checks.");
    expect($(".repo-note")?.textContent).toContain('src/main.js is the "main" in package.json');
    expect(text).toContain("Found: main (current).");
    await click(buttonByText("Use node --check src/main.js"));
    expect(field("Checks").value).toBe("node --check src/main.js");
    expect($(".repo-note")).toBeNull();
    await click(buttonByText("Add repo"));
    expect(fake.command).toHaveBeenCalledWith(expect.objectContaining({ type: "add_repo", checks: ["node --check src/main.js"] }));
  });

  it("explains checks without a fallback button when none fits, and not when checks are set", async () => {
    await mountWith({ suggestion: { ok: true, data: NONE } });
    await click(buttonByText("+ Add repo"));
    expect($(".repo-note")?.textContent).toContain("No checks found in this folder.");
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

describe("Set up git", () => {
  const preview = {
    files: 14,
    bytes: 131072,
    sample: [
      { path: "README.md", bytes: 2048 },
      { path: "src/main.js", bytes: 6144 },
    ],
    more: [],
    addsGitignore: true,
    leftOut: [
      { name: ".DS_Store", files: 1 },
      { name: "node_modules/", files: 1832 },
      { name: ".env", files: 1 },
    ],
    refusal: null,
  };
  const NOT_REPO = { ...SUGGESTION, gitRepo: false, hasCommits: false, branch: null, checks: [], checksFrom: [], branches: [], problem: "This folder isn't a git repo yet.", firstCommit: preview };
  const COMMIT_REPLY = (command: { type: string }): Reply =>
    command.type === "init_repo" ? { ok: true, data: { gitInit: true, ignoreRules: 5 } } : command.type === "first_commit" ? { ok: true, data: { commit: "3f9c2e1", files: 14 } } : { ok: true, data: null };

  it("shows what Set up git and add does and what the first commit holds, then sets up and adds", async () => {
    const fake = await mountWith({ suggestion: { ok: true, data: NOT_REPO }, commandReply: COMMIT_REPLY });
    await click(buttonByText("+ Add repo"));
    const text = $("dialog.modal")?.textContent ?? "";
    expect(text).toContain("This folder isn't a git repo yet.");
    expect(text).toContain("Set up git and add does three things in this folder, then adds the repo:");
    expect(text).toContain("git init on branch main");
    expect(text).toContain("writes a .gitignore for Node and macOS");
    expect(text).toContain("makes a first commit, Initial commit");
    expect(text).toContain("First commit14 files · 128 KB");
    expect(text).toContain("README.md2 KB");
    expect(text).toContain("and 12 more");
    expect(text).toContain("Left out by the new .gitignore");
    expect(text).toContain(".DS_Store · node_modules/ (1,832 files) · .env");
    expect(text).toContain(".env stays on disk and is never committed.");
    expect(field("Id").value).toBe("billing-api");
    expect($("dialog.modal")?.textContent).not.toContain("Base branch");
    expect(buttonByText("Add repo")).toBeUndefined();

    await click(buttonByText("Set up git and add"));
    expect(fake.command.mock.calls.map(([command]) => (command as { type: string }).type)).toEqual(["init_repo", "first_commit", "add_repo"]);
    expect(fake.command).toHaveBeenNthCalledWith(1, { type: "init_repo", path: FOLDER, baseBranch: "main" });
    expect(fake.command).toHaveBeenNthCalledWith(2, { type: "first_commit", path: FOLDER });
    expect(fake.command).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: "add_repo", id: "billing-api", baseBranch: "main" }));
    expect($("dialog.modal")).toBeNull();
    // The note stays on the board, with a way to start a task there.
    expect($(".repo-setup-note")?.textContent).toContain("Added billing-api");
    expect($(".repo-setup-note")?.textContent).toContain("3f9c2e1");
    expect($(".repo-setup-note")?.textContent).toContain("14 files");
    await click(buttonByText("Start a quick task"));
    expect($("textarea.np-text")).not.toBeNull();
    await click($('.repo-setup-note button[aria-label="Dismiss"]'));
    expect($(".repo-setup-note")).toBeNull();
  });

  it("shows each step as it runs", async () => {
    let release: (reply: Reply) => void = () => undefined;
    await mountWith({
      suggestion: { ok: true, data: NOT_REPO },
      commandReply: (command) => (command.type === "first_commit" ? (new Promise<Reply>((resolve) => (release = resolve)) as unknown as Reply) : COMMIT_REPLY(command)),
    });
    await click(buttonByText("+ Add repo"));
    await click(buttonByText("Set up git and add"));
    expect($("dialog.modal h2")?.textContent).toBe("Setting up git");
    const marks = () => [...document.querySelectorAll(".rd-steps li")].map((li) => `${li.getAttribute("data-state")}:${li.textContent}`);
    expect(marks()).toEqual(["done:✓done git init · branch main", "done:✓done Wrote .gitignore · 5 rules", "active:●running First commit · 14 files", "todo:○waiting Add repo"]);
    expect(buttonByText("Working…")).not.toBeUndefined();
    await act(async () => release({ ok: true, data: { commit: "abc1234", files: 14 } }));
    expect($("dialog.modal")).toBeNull();
  });

  it("says Make a first commit and add for a repo without commits, and shows the existing .gitignore", async () => {
    const fake = await mountWith({
      suggestion: { ok: true, data: { ...NOT_REPO, gitRepo: true, branch: "trunk", problem: "This repo has no commits yet.", firstCommit: { ...preview, files: 6, bytes: 13312, addsGitignore: false, leftOut: [] } } },
      commandReply: COMMIT_REPLY,
    });
    await click(buttonByText("+ Add repo"));
    const text = $("dialog.modal")?.textContent ?? "";
    expect(text).toContain("This repo has no commits yet. Tokama starts each piece of work on a branch from a commit. Make a first commit of what is here now, on branch trunk.");
    expect(text).toContain("6 files · 13 KB · uses your existing .gitignore");
    await click(buttonByText("Make a first commit and add"));
    expect(fake.command).toHaveBeenNthCalledWith(1, { type: "init_repo", path: FOLDER });
    expect(fake.command).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: "add_repo", baseBranch: "trunk" }));
  });

  it("explains a refusal, offers Pick another folder, and keeps the primary button off", async () => {
    const fake = await mountWith({ suggestion: { ok: true, data: { ...NOT_REPO, firstCommit: { ...preview, refusal: "This is your home folder. Pick a project folder inside it." } } } });
    await click(buttonByText("+ Add repo"));
    expect($(".rd-refusal")?.textContent).toBe("! This is your home folder. Pick a project folder inside it.");
    const primary = buttonByText("Set up git and add") as HTMLButtonElement;
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    expect(primary.disabled).toBe(true);
    await click(buttonByText("Pick another folder"));
    // The picker opens again (the fake returns the same folder, so the dialog follows).
    expect(fake.bridge.pickFolder).toHaveBeenCalledTimes(2);
  });

  it("names the failed step, what the folder holds now, and tries again", async () => {
    let failCommit = true;
    const fake = await mountWith({
      suggestion: { ok: true, data: NOT_REPO },
      commandReply: (command) => (command.type === "first_commit" && failCommit ? { ok: false, error: { code: "invalid_request", message: "git doesn't know who you are. Set user.name and user.email in your git config." } } : COMMIT_REPLY(command)),
    });
    await click(buttonByText("+ Add repo"));
    await click(buttonByText("Set up git and add"));
    const alert = $('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("✕ The first commit failed.");
    expect(alert).toContain("git doesn't know who you are.");
    expect(alert).toContain("The folder now has a .git folder and a .gitignore; nothing else changed.");
    expect($('.rd-steps li[data-state="failed"]')?.textContent).toContain("First commit");
    expect(fake.command.mock.calls.map(([command]) => (command as { type: string }).type)).toEqual(["init_repo", "first_commit"]);
    failCommit = false;
    await click(buttonByText("Try again"));
    expect($("dialog.modal")).toBeNull();
    expect(fake.command.mock.calls.map(([command]) => (command as { type: string }).type).slice(-1)).toEqual(["add_repo"]);
  });
});

describe("Edit repo", () => {
  const menuButton = () => $('button[aria-label="Actions for orders-api"]') as HTMLButtonElement;
  const openEdit = async () => {
    await click(menuButton());
    await click(menuItem("Edit…"));
  };
  const orders = setup.repos.find((repo) => repo.id === "orders-api")!;

  it("opens the dialog pre-filled with the id read-only, and saves the base branch and checks", async () => {
    const fake = await mountWith();
    await openEdit();
    expect($('[role="menu"]')).toBeNull();
    expect($("dialog.modal h2")?.textContent).toBe("Edit repo");
    expect(fake.query).not.toHaveBeenCalledWith(expect.objectContaining({ type: "suggest_repo" }));
    expect(($(".rd-fixed") as HTMLInputElement).value).toBe("orders-api");
    expect(($(".rd-fixed") as HTMLInputElement).readOnly).toBe(true);
    expect($("dialog.modal")?.textContent).toContain("read-only");
    expect($("dialog.modal")?.textContent).toContain("Items and worktrees use the id. To rename, remove the repo and add it again.");
    expect($("dialog.modal")?.textContent).toContain("New work branches start from it. Running items keep their branch.");
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
    expect($(".repo-note")?.textContent).toContain("No checks found in this folder.");
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

  it("opens with the keyboard, moves with the arrows, confirms in the app, then removes the repo", async () => {
    const fake = await mountWith();
    await key(menuButton(), "ArrowDown");
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(menuItem("Edit…"));
    expect(menuItem("Edit…")?.textContent).toBe("Edit…base branch, checks");
    await key(menuItem("Edit…") ?? null, "ArrowDown");
    expect(document.activeElement).toBe(menuItem("Remove…"));
    await key(menuItem("Remove…") ?? null, "ArrowDown");
    expect(document.activeElement).toBe(menuItem("Edit…"));
    await key(menuItem("Edit…") ?? null, "ArrowUp");
    const item = menuItem("Remove…");
    expect(document.activeElement).toBe(item);

    await click(item);
    expect($('[role="menu"]')).toBeNull();
    expect($("dialog.modal h2")?.textContent).toBe("Remove orders-api?");
    expect($("dialog.modal .dlg-body")?.textContent).toContain("Its items and worktrees are kept");
    // The safe choice has focus.
    expect(document.activeElement?.textContent).toBe("Keep");

    await click(buttonByText("Remove repo"));
    expect(fake.command).toHaveBeenCalledWith({ type: "remove_repo", repoId: "orders-api" });
    expect($("dialog.modal")).toBeNull();
  });

  it("names how many items of the repo wait for the user", async () => {
    await mountWith();
    await click(menuButton());
    await click(menuItem("Remove…"));
    const waiting = needsYouCount(items.filter((item) => (item.repoIds as readonly string[]).includes("orders-api")));
    const text = $("dialog.modal .dlg-body")?.textContent ?? "";
    if (waiting > 0) expect(text).toContain(`${waiting} ${waiting === 1 ? "item waits" : "items wait"} for you in it.`);
    else expect(text).not.toContain("for you in it.");
  });

  it("moves focus to + Add repo once the removed repo's row is gone", async () => {
    let removed = false;
    const fake = await mountWith({ setup: () => (removed ? { ok: true, data: { ...setup, repos: setup.repos.filter((repo) => repo.id !== "orders-api") } } : undefined) });
    await click(menuButton());
    await click(menuItem("Remove…"));
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
    await click(menuItem("Remove…"));
    await click(buttonByText("Keep"));
    expect($("dialog.modal")).toBeNull();
    expect(fake.command).not.toHaveBeenCalled();

    await click(menuButton());
    await key(menuItem("Remove…") ?? null, "Escape");
    expect($('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton());

    await click(menuButton());
    await click(menuItem("Remove…"));
    await click(buttonByText("Remove repo"));
    expect($('[role="alert"]')?.textContent).toBe("✕ Could not remove it: No repo has the id 'orders-api'.");
  });
});
