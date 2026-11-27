// @vitest-environment happy-dom
// The empty and error states, each rendered from the condition that causes it, and About.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../shared/bridge.js";
import { App, type AppProps } from "./App.js";
import { brand } from "./brand/index.js";
import { ABOUT_INFO, CONNECTED, fakeBridge, SETUP_DONE } from "./testing/bridge.js";
import { ITEMS, NOW, setup } from "./testing/sample.js";

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

const mount = async (fake: ReturnType<typeof fakeBridge>, props: Partial<AppProps> = {}) => {
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} {...props} />));
  return fake;
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const press = (key: string) => act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const sidebarRow = (name: string) => $$(".sb-main").find((el) => el.querySelector(".ellipsis")?.textContent === name)!;
const segment = (label: string) => $$(".filter-bar .segment").find((el) => el.querySelector("span")?.textContent === label)!;

// A first launch: no repos, no work yet (the test data's git is fine, and it names no AI CLI).
const noRepos = fakeBridgeWith({ repos: [] }, { boardItems: [] });
function fakeBridgeWith(patch: Partial<typeof setup>, options: Parameters<typeof fakeBridge>[1] = {}) {
  return (connection: ConnectionState = CONNECTED) => fakeBridge(connection, { ...options, reply: (q) => (q.type === "setup" ? { ok: true, data: { ...setup, ...patch } } : options.reply?.(q)) });
}

describe("first launch: no repos yet", () => {
  it("shows the Get started checklist in place of the list, with no repos file to edit", async () => {
    await mount(noRepos());
    expect(text(".board .gs-title")).toBe("Get started");
    expect(text(".board .gs-count")).toBe("1 of 4 done");
    expect($$(".board .gs-row-title").map((el) => el.textContent)).toEqual(["Set up an AI CLI", "Install git 2.38 or newer", "Add your first repo", "Start a Quick fix"]);
    expect($(".board .state-code")).toBeNull();
    expect(text(".board")).not.toContain("repos.yaml");
    expect($(".filter-bar")).toBeNull();
    expect($(".pipeline-list")).toBeNull();
  });

  it("disables New work and leaves out the input, and says so in the sidebar", async () => {
    await mount(noRepos());
    expect(($(".new-work") as HTMLButtonElement).disabled).toBe(true);
    expect($(".np-text")).toBeNull();
    expect(text(".sb-empty")).toBe("No repos added yet.");
  });

  it("is gone once a repo exists", async () => {
    await mount(fakeBridge(CONNECTED));
    expect($(".gs")).toBeNull();
    expect(($(".new-work") as HTMLButtonElement).disabled).toBe(false);
    expect($(".sb-empty")).toBeNull();
  });
});

describe("engine not running", () => {
  const failed: ConnectionState = { status: "failed", reason: "cannot start the engine: node was not found on PATH", logPath: "/home/a/.tokama/run/engine.log", logTail: [] };

  it("shows the reason, the log path and a Try again button", async () => {
    await mount(fakeBridge(failed));
    expect(text(".board .failure-kicker")).toBe("✕ Engine not running");
    expect(text(".board .failure-title")).toBe("The engine is not available");
    expect(text(".board .failure")).toContain(failed.reason);
    expect(text(".board .failure")).toContain(`Log ${failed.logPath}`);
    expect($$(".board .failure button").map((el) => el.textContent)).toEqual(["Try again"]);
  });

  it("asks the main process to connect again when Try again is pressed, and shows the engine starting", async () => {
    const fake = await mount(fakeBridge(failed));
    await click($(".board .failure .retry"));
    expect(fake.retryConnection).toHaveBeenCalledOnce();
    await fake.setConnection({ status: "starting" });
    expect($(".board .failure")).toBeNull();
    expect(text(".board .placeholder")).toBe("Starting the engine");
  });

  it("returns to the board when the retry connects", async () => {
    const fake = await mount(fakeBridge(failed));
    await click($(".board .failure .retry"));
    await fake.setConnection(CONNECTED);
    expect($(".pipeline-list")).not.toBeNull();
    expect($(".board .failure")).toBeNull();
  });

  it("shows a failure in the engine's log as text, never as markup", async () => {
    await mount(fakeBridge({ ...failed, reason: "<b>boom</b>" }));
    expect(text(".board .failure")).toContain("<b>boom</b>");
    expect($(".board .failure b")).toBeNull();
  });
});

describe("an older engine still running", () => {
  const older = (runningItems: number | undefined): ConnectionState => ({
    status: "failed",
    reason: "An older Tokama engine is still running. Restart it?",
    logPath: "/home/a/.tokama/run/engine.log",
    logTail: [],
    older: { lockPath: "/home/a/.tokama/run/engine.lock", pid: 48211, ...(runningItems !== undefined && { runningItems }) },
  });

  const paragraphs = () => $$(".board .failure p").map((el) => el.textContent);
  const HINT = "Tokama stops only its own engine, the one shown above. It never touches other processes.";

  it("when it did not say, asks to restart it, with the lock and the pid; Restart engine now restarts it and Try again checks again", async () => {
    const fake = await mount(fakeBridge(older(undefined)));
    expect(paragraphs()).toEqual([
      "⏸ Needs you",
      "An older engine is still running",
      "It is from the Tokama version before the update. It did not say whether it is running items. This version can’t use it.",
      "Restart engine now stops any items it is running. Each one then waits in Needs you, where you choose Retry step or Stop.",
      "Try again checks the engine again.",
      HINT,
    ]);
    expect(text(".board .failure .log")).toBe("lock  /home/a/.tokama/run/engine.lock\npid   48211");
    expect(text(".board .failure")).not.toContain("engine.log");
    expect($$(".board .failure button").map((el) => el.textContent)).toEqual(["Restart engine now", "Try again"]);
    await click($(".board .failure .retry"));
    expect(fake.bridge.restartEngine).toHaveBeenCalledOnce();
    await click($$(".board .failure button")[1]!);
    expect(fake.bridge.retryConnection).toHaveBeenCalledOnce();
  });

  it("when busy, says how many items run, and offers no Wait", async () => {
    await mount(fakeBridge(older(3)));
    expect(paragraphs()).toEqual([
      "⏸ Needs you",
      "An older engine is still running",
      "It is from the Tokama version before the update, and it is running 3 items. This version can’t use it.",
      "Restart engine now stops these items. Each one then waits in Needs you, where you choose Retry step or Stop.",
      "Try again checks whether they have finished. Once nothing is running, Tokama updates the engine by itself.",
      HINT,
    ]);
    expect($$(".board .failure button").map((el) => el.textContent)).toEqual(["Restart engine now", "Try again"]);
  });

  it("says 1 item for one, and when it checked after Try again found it still busy", async () => {
    const state = older(1);
    await mount(fakeBridge({ ...state, older: { ...(state as { older: object }).older, checkedAt: new Date(2026, 10, 26, 9, 5).getTime() } } as ConnectionState));
    expect(text(".board .failure .detail")).toBe("It is from the Tokama version before the update, and it is running 1 item. This version can’t use it.");
    expect(text(".board .older-checked")).toBe("Checked at 09:05. Not finished yet.");
  });

  it("shows the older engine in the header chip", async () => {
    await mount(fakeBridge(older(3)));
    expect(text(".main-header .engine-chip")).toBe("⏸Older engine running");
  });

  it("says Updating engine while it replaces it", async () => {
    await mount(fakeBridge({ status: "starting", updating: true }));
    expect($$(".board .failure p").map((el) => el.textContent)).toEqual(["● Updating engine…", "Stopping the older engine and starting the new one. This takes a few seconds."]);
    expect($$(".board button")).toHaveLength(0);
    expect(text(".main-header .engine-chip")).toBe("●Updating engine…");
    expect(text(".health-word")).toBe("updating engine");
  });
});

describe("no live items", () => {
  it("keeps the groups and says in each that it is empty", async () => {
    await mount(fakeBridge(CONNECTED, { boardItems: [ITEMS.done, ITEMS.failed] }));
    expect($$(".pl-group").map((group) => [group.getAttribute("aria-label"), group.querySelector(".pl-empty")?.textContent])).toEqual([
      ["Needs you", "Nothing waiting"],
      ["Running", "Nothing running"],
    ]);
    expect($(".state")).toBeNull();
  });

  it("says Nothing finished and Nothing failed for the other groups", async () => {
    await mount(fakeBridge(CONNECTED, { boardItems: [ITEMS.queued] }));
    await click(segment("Done"));
    expect(text(".pl-empty")).toBe("Nothing finished");
    await click(segment("Failed"));
    expect(text(".pl-empty")).toBe("Nothing failed");
  });

  it("names the repo in a repo view", async () => {
    await mount(fakeBridge(CONNECTED, { boardItems: [ITEMS.queued, ITEMS.failed] }));
    await click(sidebarRow("checkout-web"));
    await click(segment("Needs you"));
    expect(text(".pl-empty")).toBe("Nothing waiting for checkout-web");
  });
});

describe("a view with no work at all", () => {
  it("shows No work yet and points at the New work input", async () => {
    await mount(fakeBridge(CONNECTED, { boardItems: [] }), { initial: SETUP_DONE });
    expect(text(".board .empty-state-title")).toBe("No work yet");
    expect(text(".board .empty-state-text")).toBe("Describe a task or paste an alert below. It starts in the template you pick.");
    expect($(".filter-bar")).toBeNull();
    expect($(".np-text")).not.toBeNull();
  });

  it("shows it in a workflow's board layout too, and in a repo view when only other repos have work", async () => {
    await mount(fakeBridge(CONNECTED, { boardItems: [ITEMS.queued] }));
    await click(sidebarRow("checkout-web"));
    expect(text(".board .empty-state-title")).toBe("No work yet");
    await click(sidebarRow("DB slow query check"));
    await click($$(".layout .segment").find((el) => el.textContent === "Board")!);
    expect(text(".board .empty-state-title")).toBe("No work yet");
    expect($(".columns")).toBeNull();
  });

  it("is not shown while the view has items, even when the filter hides them all", async () => {
    await mount(fakeBridge(CONNECTED, { boardItems: [ITEMS.done] }));
    expect($(".state")).toBeNull();
    expect($$(".pl-group")).toHaveLength(2);
  });
});

describe("an AI CLI that is logged out", () => {
  const codex = [{ cliId: "codex-cli", kind: "logged_out" }] as const;

  it("shows it on the Attention icon alone, with no count, and names the CLI in the Insights tooltip", async () => {
    await mount(fakeBridge(CONNECTED), { cliIssues: codex });
    // Said once: Insights has no mark for it, and Attention is the mark itself.
    expect($$(".badge").map((badge) => [badge.getAttribute("data-tone"), badge.textContent])).toEqual([["warn", "1"]]);
    expect($(".rail .insights-tip .it-other")?.textContent).toBe(" Codex CLI✕ logged out");
    expect($('.rail button[aria-label="Attention · Codex CLI is logged out"]')).not.toBeNull();
  });

  it("shows How to log in with the command in the Attention popup, never inline", async () => {
    await mount(fakeBridge(CONNECTED), { cliIssues: codex });
    expect($(".attention-popup")).toBeNull();
    expect(text(".board")).not.toContain("logged out");
    await click($('.rail button[aria-label="Attention · Codex CLI is logged out"]'));
    const popup = $('[role="dialog"][aria-label="Attention"]')!;
    expect(popup.textContent).toContain("Codex CLI logged out");
    expect(popup.querySelector(".attention-howto")?.textContent).toBe("How to log in");
    expect(popup.querySelector("code")?.textContent).toBe("codex login");
    expect(popup.querySelectorAll("button, a")).toHaveLength(0);
  });

  it("gives Claude Code its own login command", async () => {
    await mount(fakeBridge(CONNECTED), { cliIssues: [{ cliId: "claude-code", kind: "logged_out" }] });
    await click($('.rail button[aria-label="Attention · Claude Code is logged out"]'));
    expect(text(".attention-item code")).toBe("claude auth login");
    expect(text(".attention-what")).toBe("Claude Code logged out");
  });

  it("lists every logged-out CLI", async () => {
    await mount(fakeBridge(CONNECTED), { cliIssues: [...codex, { cliId: "claude-code", kind: "logged_out" }] });
    await click($('.rail button[aria-label="Attention · 2 things to fix"]'));
    expect($$(".attention-item code").map((el) => el.textContent)).toEqual(["codex login", "claude auth login"]);
  });

  it("closes the popup on Escape, on a press outside and on the button again", async () => {
    await mount(fakeBridge(CONNECTED), { cliIssues: codex });
    const button = () => $('.rail button[aria-label="Attention · Codex CLI is logged out"]');
    await click(button());
    expect(button()?.getAttribute("aria-expanded")).toBe("true");
    await press("Escape");
    expect($(".attention-popup")).toBeNull();
    await click(button());
    await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect($(".attention-popup")).toBeNull();
    await click(button());
    await click(button());
    expect($(".attention-popup")).toBeNull();
  });

  it("has no Attention button, and no popup text, when there is no issue", async () => {
    await mount(fakeBridge(CONNECTED));
    expect($('.rail button[aria-label^="Attention"]')).toBeNull();
    expect($$(".badge").map((badge) => badge.getAttribute("data-tone"))).toEqual(["warn"]);
  });
});

describe("About", () => {
  const open = async (fake = fakeBridge(CONNECTED)) => {
    await mount(fake);
    await click($('.rail button[aria-label="About Tokama"]'));
    return fake;
  };
  const rows = () => $$(".about-row").map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);

  it("opens from the rail's user button and shows the name, the version, the platform and the lead", async () => {
    await open();
    expect(text("main h1")).toBe("About");
    expect($(".about-wordmark")?.getAttribute("alt")).toBe("Tokama");
    expect(text(".about-version")).toBe("Version 1.2.3·macOS · arm64");
    expect(text(".about-lead")).toContain("Agent workbench for engineers.");
    expect(text(".about-links")).toContain("Open source under the Apache License 2.0");
    expect(text(".about-foot")).toBe("Tokama · Apache License 2.0");
    expect(text(".about-body")).toContain("Claude and the Claude logo are trademarks of Anthropic. The OpenAI logo is a trademark of OpenAI. The Apache-2.0 licence does not license these marks.");
    expect(text(".about-body")).not.toContain("Amsterdam");
    expect(text(".about-body")).not.toContain("Thank you");
    expect($('.rail-user[aria-label="About Tokama"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("says how the name is said and where it comes from, in soft text", async () => {
    await open();
    expect(text(".about-aka")).toBe("Tokama · say to-KA-maNamed after the Tokay gecko and the Agama lizard.");
    expect($(".about-aka em")?.textContent).toBe("to-KA-ma");
  });

  it("plays the call of the Tokay from the mark, shows Playing for a moment, and clears the timer on leaving", async () => {
    vi.useFakeTimers();
    try {
      const fake = await open();
      const call = $('button[aria-label="Play the Tokay call"]');
      expect(call?.getAttribute("title")).toBe("Play the Tokay call");
      expect(call?.querySelector("img")?.getAttribute("alt")).toBe("");
      expect(text(".about-calling")).toBe("");
      expect($(".about-calling")?.hasAttribute("data-playing")).toBe(false);
      await click(call);
      expect($(".about-calling")?.hasAttribute("data-playing")).toBe(true);
      expect(fake.playSound).toHaveBeenCalledWith("tokayCall", "tokama");
      expect(text(".about-calling")).toBe("♪ Playing");
      expect($(".about-calling")?.getAttribute("aria-live")).toBe("polite");
      await act(async () => vi.advanceTimersByTime(1900));
      expect(text(".about-calling")).toBe("");
      await click(call);
      await act(async () => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
      root = createRoot(container);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists the build facts, with the engine's status from the connection", async () => {
    await open();
    expect(rows()).toEqual([
      ["App", "1.2.3 · 2026-11-24 · 85a75e3"],
      ["Engine", "1.2.3 · running · pid 48211"],
      ["Engine API", "v4"],
      ["Data folder", "~/.tokama"],
      ["Runtime", "Electron 45.4.1 · Node 24.1.0"],
    ]);
  });

  it("asks the main process to copy the build info and to show the data folder", async () => {
    const fake = await open();
    await click($(".about-copy"));
    expect(fake.copyBuildInfo).toHaveBeenCalledOnce();
    expect(text(".about-copy")).toBe("✓ Copied");
    await click(($$(".about-row button")[0] ?? null));
    expect(fake.showDataFolder).toHaveBeenCalledOnce();
    expect(text(".about-row button")).toBe("Show in Finder");
    expect($(".about-error")).toBeNull();
  });

  it("says so when the build info cannot be copied or the folder cannot open", async () => {
    await open(fakeBridge(CONNECTED, { copyBuildInfo: async () => Promise.reject(new Error("no")), showDataFolder: async () => ({ ok: false, message: "No file manager." }) }));
    await click($(".about-copy"));
    expect(text(".about-copy")).toBe("Could not copy");
    await click($(".about-row button"));
    expect(text(".about-error")).toBe("No file manager.");
  });

  it("names the file manager by system", async () => {
    await open(fakeBridge(CONNECTED, { about: { ...ABOUT_INFO, platform: "Linux · x64" } }));
    expect(text(".about-row button")).toBe("Show in file manager");
  });

  const noticesLink = () => $$(".about-section-head button").find((button) => button.textContent === "Open full licence texts") ?? null;

  it("opens the shipped licence texts from the notices section", async () => {
    const fake = await open();
    await click(noticesLink());
    expect(fake.openNotices).toHaveBeenCalledOnce();
    expect($(".about-error")).toBeNull();
  });

  it("says why the licence texts did not open", async () => {
    await open(fakeBridge(CONNECTED, { openNotices: async () => ({ ok: false, message: "No app opens Markdown." }) }));
    await click(noticesLink());
    expect(text(".about-error")).toBe("No app opens Markdown.");
  });

  it("lists the third-party notices all closed, and each opens and closes on its own click", async () => {
    await open();
    const heads = () => $$(".about-notice-head").map((head) => head.getAttribute("aria-expanded"));
    expect(text(".about-count")).toBe("8");
    expect(heads()).toEqual(["false", "false", "false", "false", "false", "false", "false", "false"]);
    expect($$(".about-notice-body")).toHaveLength(0);
    expect($(".about-all")).toBeNull();
    await click($$(".about-notice-head")[1] ?? null);
    expect(heads()).toEqual(["false", "true", "false", "false", "false", "false", "false", "false"]);
    expect($$(".about-notice-head")[1]?.textContent).toContain("45.4.1");
    await click($$(".about-notice-head")[0] ?? null);
    expect(heads()).toEqual(["true", "true", "false", "false", "false", "false", "false", "false"]);
    expect(text(".about-notice-body")).toContain("is a Lucide icon");
    await click($$(".about-notice-head")[1] ?? null);
    expect(heads()).toEqual(["true", "false", "false", "false", "false", "false", "false", "false"]);
  });

  it("renders notice and build text as text", async () => {
    await open(fakeBridge(CONNECTED, { about: { ...ABOUT_INFO, dataFolder: "<img src=x onerror=alert(1)>" } }));
    expect($(".about-row img")).toBeNull();
    expect(rows()[3]?.[1]).toBe("<img src=x onerror=alert(1)>");
  });

  it("links to tokama.dev, opened by the window in the system browser", async () => {
    await open();
    const link = $(".about-link") as HTMLAnchorElement;
    expect([link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["tokama.dev↗", "https://tokama.dev", "_blank", "noreferrer noopener"]);
  });

  it("takes the logo from the brand assets folder", async () => {
    await open();
    const [mark, wordmark] = $$(".about-logo img");
    expect([mark?.getAttribute("src"), wordmark?.getAttribute("src")]).toEqual([brand.iconUrl, brand.wordmarkUrl]);
  });

  it("replaces the board and the drawer, and the way back is the button, the Board icon, the avatar or a sidebar row", async () => {
    await open();
    expect($(".pipeline-list")).toBeNull();
    expect($(".new-work")).not.toBeNull();
    await click($(".about-back"));
    expect(text("main h1")).toBe("All work");
    for (const leave of [() => $('.rail button[aria-label="Board"]'), () => $('.rail button[aria-label="About Tokama"]'), () => sidebarRow("All work")]) {
      await click($('.rail button[aria-label="About Tokama"]'));
      expect(text("main h1")).toBe("About");
      await click(leave());
      expect(text("main h1")).toBe("All work");
    }
  });

  it("shows a placeholder, then says so, when the build info cannot be read", async () => {
    const fake = fakeBridge(CONNECTED);
    (fake.bridge.getAboutInfo as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gone"));
    await open(fake);
    expect(text(".about-version")).toBe("Version …");
    expect(text(".about-section .about-soft")).toBe("The build info could not be read.");
  });
});
