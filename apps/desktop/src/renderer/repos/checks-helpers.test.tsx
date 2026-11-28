// @vitest-environment happy-dom
import { HELPER_LOCAL_ONLY, HELPER_NO_CLI } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_STATE } from "../../shared/desktop-state.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { POLL_MS } from "./useChecksHelpers.js";
import { RepoDialog } from "./RepoDialog.js";

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
});

const FOLDER = "/home/dev/code/orders-api";
const SUGGESTION = {
  path: FOLDER,
  displayPath: "~/code/orders-api",
  gitRepo: true,
  hasCommits: true,
  branch: "main",
  id: "orders-api",
  checks: ["npm test"],
  checksFrom: ["test"],
  setup: null,
  setupFrom: null,
  defaultBranch: "main",
  branches: [{ name: "main", group: "default" }],
  moreBranches: 0,
  fallbackCheck: null,
  fallbackFromPackage: false,
  firstCommit: null,
  problem: null,
};
const AGENT = { agentId: "helper", name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" };
const SUMMARY = { helperId: "suggest-checks", name: "Suggest checks", version: 1, available: true, agent: AGENT, sends: ["file names", "build files"] };
const RUN_ID = "hrun_1";
const TRIAL_ID = "trial_1";
const run = (patch: Record<string, unknown>) => ({ runId: RUN_ID, helperId: "suggest-checks", helperVersion: 1, state: "running", phase: "gathering", startedAt: 1, agent: AGENT, ...patch });
const trial = (patch: Record<string, unknown>) => ({ trialId: TRIAL_ID, state: "running", startedAt: 1, commit: "4f9c2ab", checks: [], ...patch });
const ANSWER = {
  checks: [
    { command: "npm test", why: "Runs the unit tests.", minutes: 2 },
    { command: "npm run lint", why: "ESLint is set up.", minutes: 1 },
    { command: "npm run build", why: "The CI workflow builds first.", minutes: 3 },
  ],
};

interface Options {
  helpers?: unknown;
  suggestion?: Record<string, unknown>;
  consent?: readonly string[];
  commandReply?: (command: { type: string; [key: string]: unknown }) => Reply;
  query?: (query: { type: string }) => Reply | undefined;
  repo?: { id: string; baseBranch: string; checks: string[]; path?: string };
  onOpenGetStarted?: () => void;
}

async function mount(options: Options = {}) {
  const fake = fakeBridge(CONNECTED, {
    desktopState: { ...DEFAULT_DESKTOP_STATE, ...(options.consent === undefined ? {} : { helperConsent: options.consent as never }) },
    reply: (query) => {
      const custom = options.query?.(query);
      if (custom !== undefined) return custom;
      if (query.type === "helpers") return { ok: true, data: { helpers: options.helpers === undefined ? [SUMMARY] : options.helpers } };
      if (query.type === "suggest_repo") return { ok: true, data: { ...SUGGESTION, ...options.suggestion } };
      if (query.type === "repo_branches") return { ok: true, data: { defaultBranch: "main", branches: [{ name: "main", group: "default" }], moreBranches: 0 } };
      return undefined;
    },
    commandReply: (command) => options.commandReply?.(command as never) ?? { ok: true, data: null },
  });
  const props = options.repo === undefined ? { path: FOLDER } : { repo: options.repo as never };
  await act(async () => root.render(<RepoDialog bridge={fake.bridge} onClose={() => undefined} {...(options.onOpenGetStarted === undefined ? {} : { onOpenGetStarted: options.onOpenGetStarted })} {...props} />));
  return fake;
}

const $ = <T extends Element = Element>(selector: string) => document.querySelector<T>(selector);
const text = () => $("dialog.modal")?.textContent ?? "";
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const button = (name: string | RegExp) => [...document.querySelectorAll("button")].find((el) => (typeof name === "string" ? el.textContent === name : name.test(el.textContent ?? "")) || el.getAttribute("aria-label") === name);
const checks = () => document.querySelector<HTMLTextAreaElement>("textarea[id]:not(.ch-edit):not(.rd-setup)")!;
const setupField = () => document.querySelector<HTMLTextAreaElement>("textarea.rd-setup")!;
const type = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** A command that answers with these replies in turn, for the run_helper and try_checks commands. */
const replies =
  (map: Record<string, Reply>) =>
  (command: { type: string }): Reply =>
    map[command.type] ?? { ok: true, data: null };
const START: Record<string, Reply> = { run_helper: { ok: true, data: { runId: RUN_ID } }, try_checks: { ok: true, data: { trialId: TRIAL_ID } } };

describe("Suggest with AI", () => {
  it("asks once before the first send to a cloud AI tool, remembers the answer, and sends nothing before it", async () => {
    const fake = await mount({ commandReply: replies(START) });
    expect(text()).toContain("Suggest with AI sends the file names and build files of this folder to Claude Code · haiku. No source files, no .env.");
    await click(button("Suggest with AI"));
    expect(text()).toContain("Send this folder's file names and build files to Claude Code?");
    expect(text()).toContain("Claude Code · haiku, a cloud AI tool. It leaves this computer.");
    // What is sent is named from the engine's own list.
    expect(text()).toContain("File names and build files of this folder.");
    expect(button("Try checks")).toBeUndefined();
    expect(fake.command).not.toHaveBeenCalled();
    // Not now sends nothing and brings the buttons back.
    await click(button("Not now"));
    expect(fake.command).not.toHaveBeenCalled();
    expect(button("Suggest with AI")).toBeDefined();
    await click(button("Suggest with AI"));
    await click(button("Send and suggest"));
    expect(fake.command).toHaveBeenCalledWith({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: FOLDER } }, cloud: "accepted" });
    expect(fake.saveLayout).toHaveBeenCalledWith({ helperConsent: ["claude-code"] });
  });

  it("runs at once when the tool was agreed to before, and shows the phases with a Stop that cancels", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    expect(text()).not.toContain("Send this folder's");
    expect(fake.command).toHaveBeenCalledWith(expect.objectContaining({ type: "run_helper", cloud: "accepted" }));
    expect($(".ch-status")?.textContent).toContain("Reading file names and build files");
    expect(text()).toContain("Sending the file names and build files of this folder to Claude Code · haiku.");
    await fake.pushEvent({ type: "helper_run_updated", run: run({ phase: "asking" }) } as never);
    expect($(".ch-status")?.textContent).toContain("Asking Claude Code · haiku");
    await fake.pushEvent({ type: "helper_run_updated", run: run({ phase: "retrying" }) } as never);
    expect($(".ch-status")?.textContent).toContain("Asking again, the first answer could not be read");
    await click(button("Stop"));
    expect(fake.command).toHaveBeenCalledWith({ type: "cancel_helper", runId: RUN_ID });
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "cancelled", phase: undefined, endedAt: 2 }) } as never);
    expect(text()).toContain("Stopped.");
    expect(text()).toContain("Nothing was added to Checks.");
    expect(button("Suggest with AI")).toBeDefined();
  });

  it("hears an update that comes before the reply that names its run", async () => {
    let release: () => void = () => undefined;
    const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "helpers" ? { ok: true, data: { helpers: [SUMMARY] } } : query.type === "suggest_repo" ? { ok: true, data: SUGGESTION } : undefined) });
    const slow = new Promise<Reply>((resolve) => (release = () => resolve({ ok: true, data: { runId: RUN_ID } })));
    (fake.bridge.command as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => slow);
    (fake.bridge.getDesktopState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_DESKTOP_STATE, helperConsent: ["claude-code"] });
    await act(async () => root.render(<RepoDialog bridge={fake.bridge} path={FOLDER} onClose={() => undefined} />));
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: ANSWER } }) } as never);
    expect($(".ch-rows")).toBeNull();
    await act(async () => release());
    expect($(".ch-rows")).not.toBeNull();
  });

  it("lists the answer without adding or running anything, then adds a row by hand", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: ANSWER } }) } as never);
    const card = $(".ch-card")!;
    expect(card.textContent).toContain("Suggested by Claude Code · haiku");
    expect(card.textContent).toContain("3 checks · 2 new");
    expect(card.textContent).toContain("already in Checks");
    expect(card.textContent).toContain("The AI wrote these lines. Tokama has not run them.");
    expect(card.textContent).toContain("about 3 min");
    // Nothing was added or run by the answer.
    expect(checks().value).toBe("npm test");
    expect(fake.command.mock.calls.map(([command]) => command.type)).toEqual(["run_helper"]);

    await click(button("Add npm run lint"));
    expect(checks().value).toBe("npm test\nnpm run lint");
    expect($(".ch-card")!.textContent).toContain("✓ Added");
    expect($(".ch-card")!.textContent).toContain("3 checks · 1 new");
    // Removing a row takes it off the list; the field is not touched.
    await click(button("Remove npm run build"));
    expect($(".ch-card")!.textContent).not.toContain("The CI workflow builds first.");
    expect($(".ch-card")!.textContent).toContain("2 checks · 0 new");
    expect((button("Add all new") as HTMLButtonElement).disabled).toBe(true);
    expect(checks().value).toBe("npm test\nnpm run lint");
  });

  it("adds every new row with Add all new, on new lines, once", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: ANSWER } }) } as never);
    await click(button("Add all new"));
    expect(checks().value).toBe("npm test\nnpm run lint\nnpm run build");
    expect((button("Add all new") as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits a row under the one-command rule and adds it without saving the repo", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: ANSWER } }) } as never);
    await click(button("Edit npm run build"));
    const edit = $<HTMLTextAreaElement>(".ch-edit")!;
    expect(edit.value).toBe("npm run build");
    await type(edit, "npm run build && npm test");
    expect(text()).toContain("One command only: no &&, | or redirects. Put the second command on its own line.");
    expect(edit.closest(".ch-row")!.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    // Enter in the field must not submit the repo form, and adds nothing while the rule is broken.
    await act(async () => void edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(checks().value).toBe("npm test");
    await type(edit, "npm run build -- --mode ci");
    expect(text()).not.toContain("One command only");
    await act(async () => void edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(checks().value).toBe("npm test\nnpm run build -- --mode ci");
    expect(fake.command.mock.calls.map(([command]) => command.type)).toEqual(["run_helper"]);
    // The row now stands for the edited command: the original cannot be added as well.
    expect($(".ch-card")!.textContent).toContain("npm run build -- --mode ci");
    expect($(".ch-card")!.textContent).toContain("✓ Added");
    expect(button("Add npm run build")).toBeUndefined();
  });

  it("cancels a run whose start reply comes after the dialog closed or Stop was pressed", async () => {
    const releases: Array<() => void> = [];
    const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "helpers" ? { ok: true, data: { helpers: [SUMMARY] } } : query.type === "suggest_repo" ? { ok: true, data: SUGGESTION } : undefined) });
    const command = fake.bridge.command as unknown as ReturnType<typeof vi.fn>;
    command.mockImplementation((c: { type: string }) => (c.type === "run_helper" || c.type === "try_checks" ? new Promise((resolve) => releases.push(() => resolve({ ok: true, data: c.type === "run_helper" ? { runId: RUN_ID } : { trialId: TRIAL_ID } }))) : Promise.resolve({ ok: true, data: null })));
    (fake.bridge.getDesktopState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_DESKTOP_STATE, helperConsent: ["claude-code"] });
    await act(async () => root.render(<RepoDialog bridge={fake.bridge} path={FOLDER} onClose={() => undefined} />));
    // Stop before the reply: the line ends at once, and the run is cancelled when its id is known.
    await click(button("Suggest with AI"));
    await click(button("Stop suggesting"));
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancel_helper" }));
    expect(text()).toContain("Stopped.");
    await act(async () => releases.shift()!());
    expect(command).toHaveBeenCalledWith({ type: "cancel_helper", runId: RUN_ID });
    expect(text()).toContain("Stopped.");
    // Close before the reply of a trial and of a run.
    await click(button("Try checks"));
    await click(button("Suggest with AI"));
    act(() => root.unmount());
    await act(async () => releases.splice(0).forEach((release) => release()));
    expect(command).toHaveBeenCalledWith({ type: "cancel_check_trial", trialId: TRIAL_ID });
    expect(command.mock.calls.filter(([c]) => c.type === "cancel_helper")).toHaveLength(2);
    root = createRoot(container);
  });

  it("shows a long command in full, as text, and never as markup", async () => {
    const long = `npm run build -- ${"--flag=value ".repeat(35).trim()}`;
    const hostile = `echo <img src=x onerror=alert(1)>`;
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    await fake.pushEvent({
      type: "helper_run_updated",
      run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: { checks: [{ command: long, why: "<b>bold</b> reason", minutes: 1 }, { command: hostile, why: "x", minutes: 1 }], note: "<i>note</i>" } } }),
    } as never);
    const texts = [...document.querySelectorAll(".ch-command-text")].map((el) => el.textContent);
    expect(texts).toEqual([long, hostile]);
    expect(long.length).toBeGreaterThan(400);
    expect($(".ch-card img")).toBeNull();
    expect($(".ch-card b")).toBeNull();
    expect($(".ch-why")?.textContent).toBe("<b>bold</b> reason");
  });

  it("says an empty answer is a result, with the AI's note as text", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START), suggestion: { checks: [], checksFrom: [] } });
    // With nothing in the field the button is in the "No checks found" box.
    expect(text()).toContain("No checks found in this folder.");
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: { checks: [], note: "No build file. <i>Type them.</i>" } } }) } as never);
    expect(text()).toContain("Claude Code · haiku suggested no checks");
    expect($(".ch-note")?.textContent).toBe("No build file. <i>Type them.</i>");
    expect($(".ch-note i")).toBeNull();
    expect(text()).toContain("You can add the repo without checks.");
  });

  it("shows a refused folder in the engine's words, never as a crash", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "failed", phase: undefined, endedAt: 2, error: { code: "crash", message: "This is the home folder, not a project's." } }) } as never);
    expect(text()).toContain("This is the home folder, not a project's. Nothing was added to Checks.");
    expect(text()).not.toMatch(/crash/i);
    await click(button("Try again"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "failed", phase: undefined, endedAt: 3, error: { code: "bad_answer", message: "Claude Code · haiku answered twice in a form Tokama could not read." } }) } as never);
    expect(text()).toContain("No usable answer.");
    expect(button("Try again")).toBeDefined();
  });

  it("opens Get started from the line for a logged out tool, and shows a refused start", async () => {
    const opened = vi.fn();
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START), onOpenGetStarted: opened });
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "failed", phase: undefined, endedAt: 2, error: { code: "auth", message: "Claude Code is logged out." } }) } as never);
    expect(text()).toContain("Logged out.");
    await click(button("Open Get started"));
    expect(opened).toHaveBeenCalledOnce();
  });

  it("says why the button is off: no AI CLI ready, local-only mode, or another problem", async () => {
    const opened = vi.fn();
    await mount({ helpers: [{ ...SUMMARY, available: false, problem: HELPER_NO_CLI, agent: undefined }], onOpenGetStarted: opened });
    expect((button("Suggest with AI") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("No AI CLI is ready on this computer.");
    await click(button("Open Get started"));
    expect(opened).toHaveBeenCalledOnce();
    // Try checks does not need an AI tool.
    expect((button("Try checks") as HTMLButtonElement).disabled).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    await mount({ helpers: [{ ...SUMMARY, available: false, problem: HELPER_LOCAL_ONLY }] });
    expect((button("Suggest with AI") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("Off in local-only mode.");
    expect(text()).toContain("Nothing is sent.");
    act(() => root.unmount());
    root = createRoot(container);
    await mount({ helpers: [{ ...SUMMARY, available: false, problem: "The agent helper does not load: bad file." }] });
    expect(text()).toContain("Suggest with AI is not available.");
    expect(text()).toContain("The agent helper does not load: bad file.");
  });

  it("offers no Suggest with AI when the engine lists no helper", async () => {
    await mount({ helpers: [] });
    expect(button("Suggest with AI")).toBeUndefined();
    expect(button("Try checks")).toBeDefined();
  });

  it("never asks a local AI tool, and says it stays on this computer", async () => {
    const fake = await mount({ helpers: [{ ...SUMMARY, agent: { ...AGENT, cliId: "ollama", model: "qwen", runsOn: "local" } }], commandReply: replies(START) });
    expect(text()).toContain("It stays on this computer.");
    await click(button("Suggest with AI"));
    expect(fake.command).toHaveBeenCalledWith({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: FOLDER } } });
  });

  it("keeps the dialog on screen when either card is closed with its ✕", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: ANSWER } }) } as never);
    await click($(".ch-card [aria-label='Close']"));
    expect($(".ch-card")).toBeNull();
    expect(text()).toContain("Suggest with AI");
    // The card of an empty answer is another return of the same component.
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 3, result: { helperId: "suggest-checks", value: { checks: [], note: "No build file." } } }) } as never);
    expect(text()).toContain("suggested no checks");
    await click($(".ch-card [aria-label='Close']"));
    expect($(".ch-card")).toBeNull();
    expect(button("Suggest with AI")).toBeDefined();
  });

  it("announces only the phase of a running suggestion, and names each Stop for what it stops", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    expect($(".ch-status")?.getAttribute("role")).toBeNull();
    expect($(".ch-status-word")?.getAttribute("role")).toBe("status");
    expect($(".ch-time")?.closest("[role='status']")).toBeNull();
    expect(button("Stop suggesting")).toBeDefined();
    await click(button("Stop suggesting"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "cancelled", phase: undefined, endedAt: 2 }) } as never);
    await type(checks(), "npm test");
    await click(button("Try checks"));
    expect(button("Stop trying checks")).toBeDefined();
  });

  it("merges a new agreement with the tools already stored, not over them", async () => {
    const fake = await mount({ consent: ["codex-cli"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    await click(button("Send and suggest"));
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ helperConsent: ["codex-cli", "claude-code"] });
  });

  it("stops what runs when the dialog closes", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await click(button("Suggest with AI"));
    act(() => root.unmount());
    expect(fake.command).toHaveBeenCalledWith({ type: "cancel_helper", runId: RUN_ID });
    root = createRoot(container);
  });

  it("ends the line when the engine no longer knows the run", async () => {
    vi.useFakeTimers();
    await mount({ consent: ["claude-code"], commandReply: replies(START), query: (query) => (query.type === "helper_run" ? { ok: false, error: { code: "not_found", message: "no run" } } : undefined) });
    await click(button("Suggest with AI"));
    await act(async () => void vi.advanceTimersByTime(POLL_MS + 10));
    expect(text()).toContain("Stopped.");
    expect(text()).toContain("Nothing was added to Checks.");
  });

  it("is in the No checks found box when the field is empty, and the buttons move under the field once it has a command", async () => {
    await mount({ suggestion: { checks: [], checksFrom: [] } });
    expect($(".repo-note .ch-box")).not.toBeNull();
    expect(button("Try checks")).toBeUndefined();
    await type(checks(), "npm test");
    expect($(".repo-note")).toBeNull();
    expect(button("Try checks")).toBeDefined();
    expect(button("Suggest with AI")).toBeDefined();
  });
});

describe("Try checks", () => {
  const three = (states: Array<Record<string, unknown>>) => ["npm test", "npm run lint", "npm run typecheck"].map((command, index) => ({ command, state: "waiting", ...states[index] }));

  it("runs what the field shows, with the suggested minutes, and shows one line per check while it runs", async () => {
    const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
    await type(checks(), "npm test\nnpm run lint\nnpm run typecheck");
    await click(button("Suggest with AI"));
    await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value: ANSWER } }) } as never);
    await click(button("Try checks"));
    expect(fake.command).toHaveBeenCalledWith({
      type: "try_checks",
      path: FOLDER,
      baseBranch: "main",
      checks: [{ command: "npm test", minutes: 2 }, { command: "npm run lint", minutes: 1 }, { command: "npm run typecheck" }],
    });
    // Before the first update the lines wait.
    expect([...document.querySelectorAll(".ch-trial-word")].map((el) => el.textContent)).toEqual(["Waiting", "Waiting", "Waiting"]);
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: trial({ checks: three([{ state: "passed", durationMs: 72_000, exitCode: 0 }, { state: "running" }]) }),
    } as never);
    expect(text()).toContain("Trying 3 checks");
    expect(text()).toContain("in a temporary worktree at main");
    expect([...document.querySelectorAll(".ch-trial-word")].map((el) => el.textContent)).toEqual(["Passed", "Running", "Waiting"]);
    expect(text()).toContain("1 m 12 s");
    expect(button("Stop")).toBeDefined();
    await click(button("Stop"));
    expect(fake.command).toHaveBeenCalledWith({ type: "cancel_check_trial", trialId: TRIAL_ID });
  });

  it("is off while the field is empty or a line breaks the rule, and says which line", async () => {
    await mount();
    await type(checks(), "npm test\nnpm run build && npm test");
    expect((button("Try checks") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("Line 2 is more than one command.");
    await type(checks(), "npm test");
    expect((button("Try checks") as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs every check, shows the failed one's output as text, copies it, and notes when the field changed", async () => {
    const output = "npm run lint\n<img src=x onerror=alert(1)>\n✖ 2 problems";
    const fake = await mount({ commandReply: replies(START) });
    await type(checks(), "npm test\nnpm run lint\nnpm run typecheck");
    await click(button("Try checks"));
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: trial({
        state: "done",
        endedAt: 5000,
        checks: three([
          { state: "passed", durationMs: 1000, exitCode: 0 },
          { state: "failed", durationMs: 14_000, exitCode: 1, outputTail: output },
          { state: "passed", durationMs: 38_000, exitCode: 0 },
        ]),
      }),
    } as never);
    expect(text()).toContain("1 of 3 checks failed");
    expect(text()).toContain("Failed, exit 1");
    expect(text()).toContain("No setup command is set. The run used a new worktree, which has no installed packages.");
    expect(text()).toContain("You can add the repo with a failing check; Quick fix will stop on it until it passes.");
    expect($(".ch-output-text")).toBeNull();
    await click(button("Output"));
    expect($(".ch-output-text")?.textContent).toBe(output);
    expect($(".ch-output img")).toBeNull();
    expect(text()).toContain("Output, last 2,000 characters");
    expect(text()).not.toContain("the checks changed since this run");
    await type(checks(), "npm test");
    expect(text()).toContain("the checks changed since this run");
    await click(button("Close the results"));
    expect($(".ch-card")).toBeNull();
  });

  it("names each other state: timed out, could not start, not run, and a header for all passed", async () => {
    const fake = await mount({ commandReply: replies(START) });
    await type(checks(), "npm test\nmake lint\nnpm run typecheck");
    await click(button("Try checks"));
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: trial({ state: "done", endedAt: 9000, checks: [{ command: "npm test", state: "timed_out", durationMs: 360_000, outputTail: "slow" }, { command: "make lint", state: "failed", outputTail: "make: not found" }, { command: "npm run typecheck", state: "skipped" }] }),
    } as never);
    expect([...document.querySelectorAll(".ch-trial-word")].map((el) => el.textContent)).toEqual(["Timed out", "Could not start", "Not run"]);
    expect(text()).toContain("2 of 3 checks failed");
    await click(button("Close the results"));
    await click(button("Try checks"));
    await fake.pushEvent({ type: "check_trial_updated", trial: trial({ state: "done", endedAt: 125_000, checks: [{ command: "npm test", state: "passed", durationMs: 1000, exitCode: 0 }, { command: "make lint", state: "passed", durationMs: 1, exitCode: 0 }, { command: "npm run typecheck", state: "passed", durationMs: 1, exitCode: 0 }] }) } as never);
    expect(text()).toContain("3 checks passed");
    expect(text()).toContain("2 m 04 s");
    expect(text()).not.toContain("You can add the repo with a failing check");
  });

  it("says a trial that could not run, and a refused start, in the engine's words", async () => {
    const fake = await mount({ commandReply: replies({ try_checks: { ok: false, error: { code: "busy", message: "Checks are already being tried. Wait for them to end, or cancel them." } } }) });
    await click(button("Try checks"));
    expect(text()).toContain("Checks are already being tried.");
    await click(button("Close the results"));
    fake.command.mockImplementation(async () => ({ ok: true, data: { trialId: TRIAL_ID } }));
    await click(button("Try checks"));
    await fake.pushEvent({ type: "check_trial_updated", trial: trial({ state: "failed", endedAt: 2, error: { code: "invalid_state", message: "This repo has no commits yet." }, checks: [{ command: "npm test", state: "skipped" }] }) } as never);
    expect(text()).toContain("This repo has no commits yet.");
  });

  it("is not offered for a repo without a commit, and is for Edit repo with the repo's path", async () => {
    await mount({ suggestion: { hasCommits: false } });
    expect(button("Try checks")).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
    const fake = await mount({ repo: { id: "orders-api", baseBranch: "develop", checks: ["npm test"], path: "~/code/orders-api" }, commandReply: replies(START) });
    await click(button("Try checks"));
    expect(fake.command).toHaveBeenCalledWith({ type: "try_checks", path: "~/code/orders-api", baseBranch: "develop", checks: [{ command: "npm test" }] });
    expect(button("Suggest with AI")).toBeDefined();
  });

  it("is not offered for an Edit repo with no folder to run in", async () => {
    await mount({ repo: { id: "orders-api", baseBranch: "main", checks: ["npm test"] } });
    expect(button("Try checks")).toBeUndefined();
    expect(button("Suggest with AI")).toBeUndefined();
  });
});

describe("Setup command", () => {
  const PNPM = { setup: "pnpm install --frozen-lockfile", setupFrom: "pnpm-lock.yaml" };
  const SETUP = "npm ci";
  const words = () => [...document.querySelectorAll(".ch-trial-word")].map((el) => el.textContent);
  const done = (patch: Record<string, unknown>) => trial({ state: "done", endedAt: 175_000, ...patch });

  it("starts empty with nothing to suggest, marked optional, and is filled from a lockfile with where it came from", async () => {
    await mount();
    expect(setupField().value).toBe("");
    expect(setupField().placeholder).toBe("pnpm install");
    expect(text()).toContain("Nothing found to suggest. Leave it empty when the checks need nothing installed.");
    expect(text()).toContain("optional");
    act(() => root.unmount());
    root = createRoot(container);
    await mount({ suggestion: PNPM });
    expect(setupField().value).toBe("pnpm install --frozen-lockfile");
    expect(text()).toContain("✓ suggested");
    expect(text()).toContain("Found pnpm-lock.yaml. Runs once in every new worktree, before the checks.");
    expect(text()).toContain("A template's own setup command replaces it.");
    // Once the user changes it, it is no longer the suggestion: the mark and "Found" go.
    await type(setupField(), "");
    expect(text()).not.toContain("Found pnpm-lock.yaml.");
    expect(document.querySelectorAll(".rd-suggested")).toHaveLength(1);
  });

  it("is saved with the repo, and left out of add_repo when empty", async () => {
    const fake = await mount({ suggestion: PNPM, commandReply: replies({ add_repo: { ok: true, data: { repo: { id: "orders-api", baseBranch: "main", checks: [] } } } }) });
    await type(setupField(), "  npm ci ");
    await click(button("Add repo"));
    expect(fake.command).toHaveBeenCalledWith(expect.objectContaining({ type: "add_repo", setup: "npm ci" }));
    act(() => root.unmount());
    root = createRoot(container);
    const empty = await mount({ commandReply: replies({ add_repo: { ok: true, data: null } }) });
    await click(button("Add repo"));
    expect(empty.command.mock.calls[0]![0]).not.toHaveProperty("setup");
  });

  it("refuses a line break, typed or pasted, and says when it is more than one command", async () => {
    await mount({ suggestion: { setup: null, setupFrom: null } });
    await type(setupField(), "npm ci\nnpm run build");
    expect(setupField().value).toBe("npm ci npm run build");
    await type(setupField(), "npm ci && npm run build");
    expect(text()).toContain("One command only. Put the second command in Checks, or in a script that the setup command runs.");
    expect(setupField().getAttribute("aria-invalid")).toBe("true");
    await type(setupField(), "npm ci");
    expect(setupField().getAttribute("aria-invalid")).toBeNull();
    expect(text()).not.toContain("One command only.");
  });

  it("runs the setup first in Try checks, with its own line above the checks", async () => {
    const fake = await mount({ suggestion: PNPM, commandReply: replies(START) });
    await click(button("Try checks"));
    expect(fake.command).toHaveBeenCalledWith({ type: "try_checks", path: FOLDER, baseBranch: "main", checks: [{ command: "npm test" }], setup: "pnpm install --frozen-lockfile" });
    // Before the first update: the setup and the check wait.
    expect(text()).toContain("Trying setup, then 1 check");
    expect(words()).toEqual(["Waiting", "Waiting"]);
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: trial({ setup: PNPM.setup, setupResult: { state: "running", startedAt: Date.now() - 41_000 }, checks: [{ command: "npm test", state: "waiting" }] }),
    } as never);
    expect([...document.querySelectorAll(".ch-group")].map((el) => el.textContent)).toEqual(["Setup", "Checks"]);
    expect(words()).toEqual(["Running", "Waiting"]);
    expect(text()).toMatch(/Running4\d s/);
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: done({ setup: PNPM.setup, setupResult: { state: "passed", exitCode: 0, durationMs: 48_000 }, checks: [{ command: "npm test", state: "passed", durationMs: 72_000, exitCode: 0 }] }),
    } as never);
    // Setup says Done, not Passed: it prepares, it does not test.
    expect(words()).toEqual(["Done", "Passed"]);
    expect(text()).toContain("Setup and 1 check passed");
  });

  it("shows a setup that failed as a result: the checks are Not run and never counted, its output is text, and the repo can still be added", async () => {
    const fake = await mount({ suggestion: PNPM, commandReply: replies(START) });
    await type(checks(), "npm test\nnpm run lint");
    await click(button("Try checks"));
    const output = "ERR_PNPM_OUTDATED_LOCKFILE <img src=x onerror=alert(1)>";
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: trial({
        state: "failed",
        endedAt: 12_000,
        error: { code: "setup_failed", message: "The setup command exited with code 1." },
        setup: PNPM.setup,
        setupResult: { state: "failed", exitCode: 1, durationMs: 12_000, outputTail: output },
        checks: [{ command: "npm test", state: "skipped" }, { command: "npm run lint", state: "skipped" }],
      }),
    } as never);
    expect(text()).toContain("Setup failed · 2 checks not run");
    expect(words()).toEqual(["Failed, exit 1", "Not run", "Not run"]);
    expect(text()).toContain("The checks need the setup command to pass first.");
    expect(text()).toContain("You can still add the repo.");
    expect(text()).not.toContain("checks failed");
    expect($(".ch-output-text")).toBeNull();
    await click(button("Output"));
    expect($(".ch-output-text")?.textContent).toBe(output);
    expect($(".ch-output img")).toBeNull();
  });

  it("says a setup that was not found could not start, with the PATH sentence, and one that timed out", async () => {
    const fake = await mount({ suggestion: PNPM, commandReply: replies(START) });
    await click(button("Try checks"));
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: trial({
        state: "failed",
        endedAt: 3000,
        error: { code: "setup_failed", message: "x" },
        setup: PNPM.setup,
        setupResult: { state: "failed", exitCode: 127, durationMs: 60, outputTail: "sh: pnpm: command not found", couldNotStart: { word: "pnpm" } },
        checks: [{ command: "npm test", state: "skipped" }],
      }),
    } as never);
    expect(words()[0]).toBe("Could not start");
    expect(text()).toContain("pnpm was not found. Tokama runs commands with the PATH of its background service, which can differ from your terminal.");
    await click(button("Close the results"));
    await click(button("Try checks"));
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: trial({ state: "failed", endedAt: 3000, error: { code: "setup_failed", message: "x" }, setup: PNPM.setup, setupResult: { state: "timed_out", durationMs: 1_200_000, outputTail: "" }, checks: [{ command: "npm test", state: "skipped" }] }),
    } as never);
    expect(words()[0]).toBe("Timed out");
    expect(text()).toContain("Setup timed out · 1 check not run");
  });

  it("still shows a trial that could not run for another reason as an error", async () => {
    const fake = await mount({ suggestion: PNPM, commandReply: replies(START) });
    await click(button("Try checks"));
    await fake.pushEvent({ type: "check_trial_updated", trial: trial({ state: "failed", endedAt: 2, error: { code: "worktree_failed", message: "No worktree." }, setup: PNPM.setup, setupResult: { state: "skipped" }, checks: [{ command: "npm test", state: "skipped" }] }) } as never);
    expect(text()).toContain("No worktree.");
    expect(text()).not.toContain("Setup failed");
  });

  it("says what is true when a check fails with no setup command, and offers the command it found", async () => {
    const fake = await mount({ commandReply: replies(START) });
    await click(button("Try checks"));
    await fake.pushEvent({
      type: "check_trial_updated",
      trial: done({ setupHint: { command: "npm ci", from: "package-lock.json" }, checks: [{ command: "npm test", state: "failed", exitCode: 127, durationMs: 1000, outputTail: "sh: vitest: command not found" }] }),
    } as never);
    expect(text()).toContain("No setup command is set. The run used a new worktree, which has no installed packages. If the output says a command or a package is missing, that is why.");
    expect(text()).toContain("found package-lock.json");
    await click(button("Use npm ci as setup"));
    // It fills the field and runs nothing.
    expect(setupField().value).toBe("npm ci");
    expect(fake.command.mock.calls.map(([command]) => command.type)).toEqual(["try_checks"]);
    // The line goes once the field holds a command.
    expect(text()).not.toContain("No setup command is set");
  });

  it("ends the line with where to find a command when no known file was found, and says nothing when the checks pass", async () => {
    const fake = await mount({ commandReply: replies(START) });
    await click(button("Try checks"));
    await fake.pushEvent({ type: "check_trial_updated", trial: done({ checks: [{ command: "npm test", state: "failed", exitCode: 1, durationMs: 1000 }] }) } as never);
    expect(text()).toContain("that is why. Add one above, or use Suggest with AI.");
    expect(button(/^Use .* as setup$/)).toBeUndefined();
    await click(button("Close the results"));
    await click(button("Try checks"));
    await fake.pushEvent({ type: "check_trial_updated", trial: done({ checks: [{ command: "npm test", state: "passed", durationMs: 1000, exitCode: 0 }] }) } as never);
    expect(text()).not.toContain("No setup command is set");
  });

  it("tries a setup command alone with no checks, and is off with neither", async () => {
    const fake = await mount({ suggestion: { checks: [] }, commandReply: replies(START) });
    expect(button("Try checks")).toBeUndefined();
    await type(setupField(), "npm ci");
    expect((button("Try setup") as HTMLButtonElement).disabled).toBe(false);
    await click(button("Try setup"));
    expect(fake.command).toHaveBeenCalledWith({ type: "try_checks", path: FOLDER, baseBranch: "main", checks: [], setup: "npm ci" });
    expect(text()).toContain("Trying setup ");
    await fake.pushEvent({ type: "check_trial_updated", trial: done({ setup: "npm ci", setupResult: { state: "passed", exitCode: 0, durationMs: 4000 }, checks: [] }) } as never);
    expect(text()).toContain("Setup done");
    expect([...document.querySelectorAll(".ch-group")].map((el) => el.textContent)).toEqual(["Setup"]);
  });

  it("turns Try checks off for a setup command that is more than one command", async () => {
    await mount();
    await type(setupField(), "npm ci && npm run build");
    expect((button("Try checks") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("The setup command is more than one command.");
  });

  describe("in Suggest with AI", () => {
    const WITH_SETUP = { ...ANSWER, setup: { command: SETUP, why: "package-lock.json is here.", minutes: 1 } };
    const suggest = async (fake: Awaited<ReturnType<typeof mount>>, value: unknown = WITH_SETUP) => {
      await click(button("Suggest with AI"));
      await fake.pushEvent({ type: "helper_run_updated", run: run({ state: "done", phase: undefined, endedAt: 2, result: { helperId: "suggest-checks", value } }) } as never);
    };

    it("lists the setup row first under its own heading, and Use as setup fills only the Setup command field", async () => {
      const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
      await suggest(fake);
      const card = $(".ch-card")!;
      expect([...card.querySelectorAll(".ch-group")].map((el) => el.textContent)).toEqual(["Setup command", "Checks"]);
      expect(card.textContent).toContain("1 setup · 3 checks · 2 new");
      expect(card.textContent).toContain("A setup command usually downloads and runs code from a package registry");
      // Nothing is added or run by the answer.
      expect(setupField().value).toBe("");
      await click(button(`Use as setup ${SETUP}`));
      expect(setupField().value).toBe(SETUP);
      expect(checks().value).toBe("npm test");
      expect(card.textContent).toContain("In Setup command");
      expect(fake.command.mock.calls.map(([command]) => command.type)).toEqual(["run_helper"]);
    });

    it("does not take the setup row with Add all new", async () => {
      const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
      await suggest(fake);
      await click(button("Add all new"));
      expect(checks().value).toBe("npm test\nnpm run lint\nnpm run build");
      expect(setupField().value).toBe("");
    });

    it("says Replace setup when the field holds another command, and already the setup command when it holds this one", async () => {
      const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
      await type(setupField(), "npm install");
      await suggest(fake);
      expect($(".ch-card")!.textContent).toContain("The field holds another command: npm install.");
      expect(button(`Use as setup ${SETUP}`)).toBeUndefined();
      await click(button(`Replace setup ${SETUP}`));
      expect(setupField().value).toBe(SETUP);
      act(() => root.unmount());
      root = createRoot(container);
      const again = await mount({ consent: ["claude-code"], suggestion: { setup: SETUP, setupFrom: "package-lock.json" }, commandReply: replies(START) });
      await suggest(again);
      expect($(".ch-card")!.textContent).toContain("already the setup command");
    });

    it("edits the setup row under the one-command rule before it is used, and removes it", async () => {
      const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
      await suggest(fake);
      await click(button(`Edit ${SETUP}`));
      const edit = $<HTMLTextAreaElement>(".ch-edit")!;
      await type(edit, "npm ci && npm run build");
      expect(text()).toContain("One command only.");
      await type(edit, "npm ci --ignore-scripts");
      await click(button("Use as setup"));
      expect(setupField().value).toBe("npm ci --ignore-scripts");
      act(() => root.unmount());
      root = createRoot(container);
      const second = await mount({ consent: ["claude-code"], commandReply: replies(START) });
      await suggest(second);
      await click(button(`Remove ${SETUP}`));
      expect([...document.querySelectorAll(".ch-group")].map((el) => el.textContent)).toEqual(["Checks"]);
    });

    it("shows an answer that holds only a setup command, and still the empty note when it holds nothing", async () => {
      const fake = await mount({ consent: ["claude-code"], commandReply: replies(START) });
      await suggest(fake, { checks: [], setup: { command: SETUP, why: "package-lock.json is here.", minutes: 1 } });
      expect($(".ch-card")!.textContent).toContain("1 setup · 0 checks · 0 new");
      expect(button(`Use as setup ${SETUP}`)).toBeDefined();
    });
  });
});
