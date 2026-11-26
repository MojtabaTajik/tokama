// @vitest-environment happy-dom
import type { AiClisResult } from "@tokama/core";
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
const type = (input: Element, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const CLAUDE = {
  supported: true,
  cliId: "claude-code",
  name: "Claude Code",
  description: "Coding agent CLI from Anthropic.",
  state: "ready",
  version: "2.1.331",
  path: "/opt/homebrew/bin/claude",
  loginCommand: "claude auth login",
  command: "claude",
  headlessArgs: ["-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose"],
  modelArgs: ["--model={model}"],
  permissionArgs: ["--restricted", "--permission-mode=dontAsk", "--tools=Read,Glob,Grep", "--allowedTools", "Bash(git diff:*)"],
  promptVia: "stdin",
  roleArgs: ["--append-system-prompt={role}"],
  envNames: ["PATH", "HOME", "USER"],
  usedBy: ["Architect", "Builder <b>x</b>"],
} as const;
const OTHERS = [
  { supported: false, cliId: "codex-cli", name: "Codex CLI", description: "Coding agent CLI from OpenAI." },
] as const;
const answer = (claude: object = CLAUDE) => ({ clis: [claude, ...OTHERS] }) as unknown as AiClisResult;

const withClis = (reply: (n: number) => Reply = () => ({ ok: true, data: answer() })) => {
  let calls = 0;
  const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "ai_clis" ? reply(++calls) : query.type === "setup" ? { ok: true, data: structuredClone(setup) } : undefined) });
  return { ...fake, calls: () => calls };
};
const open = async (fake: { bridge: TokamaBridge }) => {
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} />));
  await click($$(".rail button").find((button) => /^Settings/.test(button.getAttribute("aria-label") ?? "")));
  await click($$(".settings-entry").find((el) => el.textContent === "AI CLIs"));
};
const detail = () => $(".ai-cli-detail")?.textContent ?? "";
const rowNames = () => $$(".ai-cli-row-name").map((el) => el.textContent);

describe("Settings > AI CLIs", () => {
  it("opens from the Engine group in the settings nav and asks the engine for ai_clis", async () => {
    const fake = withClis();
    await open(fake);
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("AI CLIs");
    expect(fake.query).toHaveBeenCalledWith({ type: "ai_clis" });
    expect(rowNames()).toEqual(["Claude Code", "Codex CLI"]);
  });

  it("shows status, version, path, arguments, how instructions are passed, and environment names", async () => {
    await open(withClis());
    expect($(".ai-cli-head-text h2")?.textContent).toBe("Claude Code");
    expect($(".ai-cli-status")?.textContent).toContain("● Logged in");
    expect($(".ai-cli-status")?.textContent).toContain("2.1.331");
    expect(detail()).toContain("Found at /opt/homebrew/bin/claude.");
    expect(detail()).toContain("-p --input-format=stream-json --output-format=stream-json --verbose");
    expect(detail()).toContain("--model={model}");
    expect(detail()).toContain('--restricted --permission-mode=dontAsk --tools=Read,Glob,Grep --allowedTools "Bash(git diff:*)"');
    expect(detail()).toContain("Tokama never adds a skip-all-permissions flag.");
    expect(detail()).toContain("Step prompt: stdin");
    expect(detail()).toContain("Agent role: argument --append-system-prompt={role}");
    expect($$(".ai-cli-env li").map((el) => el.textContent)).toEqual(["PATH", "HOME", "USER"]);
    expect(detail()).toContain("Architect · Builder <b>x</b>");
    expect($(".ai-cli-detail b")).toBeNull();
  });

  it("offers no edit controls and no Restore default", async () => {
    await open(withClis());
    expect($$(".ai-clis input").map((el) => el.getAttribute("aria-label"))).toEqual(["Filter CLIs"]);
    expect($$(".ai-cli-detail input, .ai-cli-detail textarea, .ai-cli-detail select, .ai-cli-detail [role='switch'], .ai-cli-detail [role='radio']")).toEqual([]);
    expect($$(".ai-cli-detail button").map((el) => el.textContent)).toEqual(["Check again"]);
    expect(detail()).not.toContain("Restore");
  });

  it("lists Codex as not supported yet, with a symbol and a word", async () => {
    await open(withClis());
    expect($$(".ai-cli-row-state").map((el) => [el.textContent, el.getAttribute("aria-label")])).toEqual([["●", "Logged in"], ["–", "Not supported yet"]]);
    await click($$(".ai-cli-row").find((el) => el.textContent?.includes("Codex")));
    expect($(".ai-cli-head-text h2")?.textContent).toBe("Codex CLI");
    expect($(".ai-cli-status")?.textContent).toContain("– Not supported yet");
    expect(detail()).toContain("Tokama cannot run this CLI yet.");
    expect($$(".ai-cli-row-field")).toEqual([]);
    expect($$(".ai-cli-detail button")).toEqual([]);
  });

  it("says how to log in when Claude Code is not logged in, and when it is not found", async () => {
    await open(withClis(() => ({ ok: true, data: answer({ ...CLAUDE, state: "not_logged_in", message: "Claude Code is not logged in. Run `claude auth login` in a terminal, then check again." }) })));
    expect($(".ai-cli-status")?.textContent).toContain("○ Not logged in");
    expect($(".ai-cli-login")?.textContent).toBe("How to log in: run claude auth login in a terminal, then check again.");
    expect($(".ai-cli-login code")?.textContent).toBe("claude auth login");
    act(() => root.unmount());
    root = createRoot(container);
    const withoutPath: Record<string, unknown> = { ...CLAUDE };
    delete withoutPath["path"];
    await open(withClis(() => ({ ok: true, data: answer({ ...withoutPath, state: "not_installed", message: "Claude Code is not installed, or `claude` is not on the PATH." }) })));
    expect($(".ai-cli-status")?.textContent).toContain("✕ Not found");
    expect($(".ai-cli-login")?.textContent).toContain("is not installed");
    expect(detail()).toContain("Not found on the PATH Tokama passes to it.");
  });

  it("shows the message of a ready CLI next to Logged in, and no login line", async () => {
    const message = "Claude Code 2.1.294 is older than 2.1.295. Steps that run commands will fail until you update it (for example with `claude update`).";
    await open(withClis(() => ({ ok: true, data: answer({ ...CLAUDE, state: "ready", message }) })));
    expect($(".ai-cli-status")?.textContent).toContain("● Logged in");
    expect($$(".ai-cli-login").map((el) => el.textContent)).toEqual([message]);
  });

  it("checks again: keeps the answer on screen, then shows the new one", async () => {
    const fake = withClis((n) => ({ ok: true, data: answer(n === 1 ? { ...CLAUDE, state: "not_logged_in" } : CLAUDE) }));
    await open(fake);
    expect($(".ai-cli-status")?.textContent).toContain("Not logged in");
    await click($(".ai-cli-check"));
    expect(fake.calls()).toBe(2);
    expect($(".ai-cli-status")?.textContent).toContain("● Logged in");
  });

  it("filters the list and says when nothing matches", async () => {
    await open(withClis());
    const filter = $('input[aria-label="Filter CLIs"]')!;
    await type(filter, "codex");
    expect(rowNames()).toEqual(["Codex CLI"]);
    expect($(".ai-cli-head-text h2")?.textContent).toBe("Codex CLI");
    await type(filter, "zzz");
    expect(rowNames()).toEqual([]);
    expect($(".ai-clis-list-pane .placeholder")?.textContent).toBe("No CLI matches");
    expect(detail()).toBe("");
  });

  it("shows a failed load with Retry, and loads again", async () => {
    const fake = withClis((n) => (n === 1 ? { ok: false, error: { code: "internal", message: "the engine failed" } } : { ok: true, data: answer() }));
    await open(fake);
    expect($(".failure")?.textContent).toContain("Could not load the AI CLIs");
    expect($(".failure .detail")?.textContent).toBe("the engine failed");
    await click($(".failure .retry"));
    expect($(".failure")).toBeNull();
    expect(rowNames()).toHaveLength(2);
  });

  it("reads the list again after a setup change", async () => {
    const fake = withClis();
    await open(fake);
    expect(fake.calls()).toBe(1);
    await fake.pushEvent({ type: "setup_changed" });
    expect(fake.calls()).toBe(2);
  });
});
