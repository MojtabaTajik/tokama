// @vitest-environment happy-dom
import type { Health, RepoSummary } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWebsiteUrl } from "../../main/policy.js";
import { COPIED_FOR_MS } from "../ui/CopyButton.js";
import { checklist, type ChecklistInput } from "./checklist.js";
import { GetStarted, type GetStartedProps } from "./GetStarted.js";
import { SetupDoneLine } from "./SetupDoneLine.js";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const READY: Health = { git: { ok: true, version: "git version 2.47.1" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.332" }], config: [] };
const REPO = { id: "orders-api", baseBranch: "main", checks: ["npm test"], path: "~/code/orders-api" } as unknown as RepoSummary;
const input = (overrides: Partial<ChecklistInput> = {}): ChecklistInput => ({ health: READY, checkFailed: false, checking: false, repos: [REPO], templates: [], started: false, firstItem: undefined, mac: true, ...overrides });
const handlers = () => ({ onCheckAgain: vi.fn(), onAddRepo: vi.fn(), onStart: vi.fn(), onAct: vi.fn() });
const show = (given: Partial<ChecklistInput>, extra: Partial<GetStartedProps> = {}) => {
  const on = handlers();
  act(() => root.render(<GetStarted list={checklist(input(given))} checking={given.checking ?? false} {...on} {...extra} />));
  return on;
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const row = (id: string) => $(`[data-row="${id}"]`)!;
const NOT_INSTALLED: Health = { ...READY, clis: [{ cliId: "claude-code", installed: false, loggedIn: false }] };

describe("GetStarted", () => {
  it("is a region named Get started with its count, the four rows in order, and the safety note", () => {
    show({ health: NOT_INSTALLED, repos: [] });
    expect($("section")?.getAttribute("aria-label")).toBe("Get started");
    expect(text(".gs-title")).toBe("Get started");
    expect(text(".gs-count")).toBe("1 of 4 done");
    expect($$(".gs-row").map((el) => el.getAttribute("data-row"))).toEqual(["ai-cli", "git", "repo", "quick-fix"]);
    expect(text(".gs-note")).toContain("Agents stay in their own worktree.");
  });

  it("gives every row its glyph and its word, so colour is never the only signal", () => {
    show({ health: NOT_INSTALLED, repos: [] });
    const marks = $$(".gs-row").map((el) => [el.querySelector(".mark")?.textContent, el.querySelector(".gs-word")?.textContent]);
    expect(marks).toEqual([["✕", "Not installed"], ["✓", "Ready"], ["○", "To do"], ["○", "To do"]]);
    expect($$(".gs-row .mark").every((el) => el.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("fills only the button of the next step", () => {
    show({ health: NOT_INSTALLED, repos: [] });
    expect($$(".gs .btn-primary").map((el) => el.textContent)).toEqual(["Install Claude Code ↗"]);
    show({ repos: [] });
    expect($$(".gs .btn-primary").map((el) => el.textContent)).toEqual(["Add repo"]);
    show({});
    expect($$(".gs .btn-primary").map((el) => el.textContent)).toEqual(["Start a Quick fix"]);
    show({ started: true });
    expect($$(".gs .btn-primary")).toHaveLength(0);
  });

  it("keeps Start a Quick fix off until steps 1 to 3 are done", () => {
    show({ health: NOT_INSTALLED });
    const start = row("quick-fix").querySelector("button")!;
    expect([start.textContent, start.disabled]).toEqual(["Start a Quick fix", true]);
  });

  it("calls Add repo, Start a Quick fix with what to fill in, and Check again", async () => {
    const on = show({ repos: [] });
    await click(row("repo").querySelector("button"));
    expect(on.onAddRepo).toHaveBeenCalledOnce();
    const ready = show({ templates: [] });
    await click(row("quick-fix").querySelector("button"));
    expect(ready.onStart).toHaveBeenCalledWith({ repoId: "orders-api", text: "Fix typos and unclear sentences in README.md" });
    await click($(".gs-head-links button"));
    expect(ready.onCheckAgain).toHaveBeenCalledOnce();
  });

  it("shows ◌ Checking… on the AI CLI row and waits on Check again while a check runs", () => {
    show({ checking: true });
    expect([row("ai-cli").querySelector(".mark")?.textContent, row("ai-cli").querySelector(".gs-word")?.textContent]).toEqual(["◌", "Checking…"]);
    expect(($(".gs-head-links button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers Check again on a row that could not be checked", async () => {
    const on = show({ checkFailed: true });
    expect(row("ai-cli").querySelector(".gs-word")?.textContent).toBe("Could not check");
    await click(row("ai-cli").querySelector("button"));
    expect(on.onCheckAgain).toHaveBeenCalledOnce();
  });

  it("has a Close link only when it is given one, and calls it", async () => {
    show({});
    expect($$(".gs-head-links button").map((el) => el.textContent)).toEqual(["Check again"]);
    const onClose = vi.fn();
    show({}, { onClose });
    expect($$(".gs-head-links button").map((el) => el.textContent)).toEqual(["Check again", "Close"]);
    await click($$(".gs-head-links button")[1] ?? null);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies a command and says ✓ Copied for two seconds, then Copy again", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    show({ health: { ...READY, git: { ok: false, version: "git version 2.37.1" } } });
    const copy = row("git").querySelector<HTMLButtonElement>(".command-copy button")!;
    expect([copy.textContent, copy.getAttribute("aria-label")]).toEqual(["Copy", "Copy brew install git"]);
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("brew install git");
    expect(copy.textContent).toBe("✓ Copied");
    act(() => vi.advanceTimersByTime(COPIED_FOR_MS));
    expect(copy.textContent).toBe("Copy");
  });

  it("shows no command on Linux for git, and its words say so", () => {
    show({ mac: false, health: { ...READY, git: { ok: false, version: "git version 2.34.1" } } });
    expect(row("git").querySelector(".command-copy")).toBeNull();
    expect(text('[data-row="git"] .gs-detail')).toContain("Install it with your system’s package manager");
  });

  it("opens only product-site pages, in the browser: every link is one the main process allows", () => {
    show({ health: NOT_INSTALLED, repos: [] });
    show({ health: { ...READY, git: { ok: false } } });
    const links = $$("a");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://tokama.dev/docs/install-git"]);
    show({ health: NOT_INSTALLED });
    for (const a of $$("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noreferrer noopener");
      expect(isWebsiteUrl(a.getAttribute("href") ?? "")).toBe(true);
    }
    expect($$("a").map((a) => a.textContent)).toEqual(["Install Claude Code ↗"]);
  });

  it("shows the engine's words about a sandbox problem as plain text: no markup, no link, no Copy", () => {
    const message = "Install them (Ubuntu: `sudo apt-get install bubblewrap socat`). <b>x</b>";
    show({ health: { ...READY, clis: [{ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.332", message }] }, mac: false });
    const aiRow = row("ai-cli");
    expect(aiRow.querySelector(".gs-engine-text")?.textContent).toBe(message);
    expect(aiRow.querySelector(".gs-engine-text b")).toBeNull();
    expect(aiRow.querySelector("a, .command-copy, .gs-action")).toBeNull();
    expect(aiRow.querySelector(".gs-word")?.textContent).toBe("Needs a fix");
  });

  it("names the repo's checks as code, and a first run in a quote", () => {
    show({ started: true, firstItem: { text: "Fix typos", repoId: "orders-api" } });
    expect(row("repo").querySelector("code")?.textContent).toBe("~/code/orders-api");
    expect(row("quick-fix").querySelector("q")?.textContent).toBe("Fix typos");
    expect(text(".gs-intro")).toBe("Everything is set up. If a step breaks later, its row shows the fix.");
  });

  it("opens Settings > Templates from the safety note, and the repo dialog from add a check", async () => {
    const quickFix = { id: "builtin/quick-fix", name: "Quick fix", steps: [{ name: "Run checks", checks: { from: "repo" } }] };
    const quickChange = { id: "builtin/quick-change", name: "Quick change", steps: [{ name: "Fix" }] };
    const on = show({ repos: [{ ...REPO, checks: [] } as unknown as RepoSummary], templates: [quickFix, quickChange] as never });
    await click($(".gs-note button"));
    expect(on.onAct).toHaveBeenCalledWith("open-templates");
    await click($(".gs-detail .btn-link"));
    expect(on.onAct).toHaveBeenLastCalledWith("edit-repo");
    expect(row("quick-fix").querySelector(".gs-action")?.textContent).toBe("Start a Quick change");
  });
});

describe("SetupDoneLine", () => {
  it("says setup is done and where the list went, and closes with ✕", async () => {
    const onClose = vi.fn();
    act(() => root.render(<SetupDoneLine workflow="Quick fix" onClose={onClose} />));
    expect($("[role=status]")).not.toBeNull();
    expect(text(".gs-line-title")).toBe("Setup done");
    expect(text(".gs-line-text")).toBe("Your first Quick fix is running. When it finishes, you choose: merge it, open a PR or discard it. This list is under Help › Get started.");
    await click($("button[aria-label=Close]"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("names work in general while the first item is not known", () => {
    act(() => root.render(<SetupDoneLine workflow={undefined} onClose={() => undefined} />));
    expect(text(".gs-line-text")).toContain("Your first work is running.");
  });
});
