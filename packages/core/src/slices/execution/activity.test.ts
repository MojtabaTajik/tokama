import { describe, expect, it } from "vitest";
import { type AgentCallEvent, MAX_ACTIVITY_LABEL_CHARS, quietForMs, QUIET_AFTER_MS } from "../../kernel/schemas/index.js";
import { actionOf, createActivityTracker, labelText, redactPaths } from "./activity.js";

const tool = (id: string, name: string, kind: "edit" | "command" | "other", input: Record<string, string>): AgentCallEvent => ({ type: "tool_call", id, name, kind, input });

describe("activity words", () => {
  it.each([
    [tool("t", "Read", "other", { file_path: "src/board.ts" }), "read", "reading src/board.ts"],
    [tool("t", "Edit", "edit", { file_path: "src/orders/list.ts", change: "abc" }), "edit", "editing src/orders/list.ts"],
    [tool("t", "Write", "edit", { file_path: "src/new.ts", change: "abc" }), "edit", "editing src/new.ts"],
    [tool("t", "Bash", "command", { command: "pnpm test src/orders" }), "run", "running pnpm test src/orders"],
    [tool("t", "Grep", "other", { pattern: "nextCursor", path: "src" }), "read", "searching nextCursor"],
    [tool("t", "mcp__App Insights__query", "other", { query: "requests | take 10" }), "other", "using App Insights · query"],
    [tool("t", "WebFetch", "other", { url: "https://example.com/private?token=1" }), "other", "using WebFetch"],
  ] as const)("says what %o does", (event, kind, label) => {
    expect(actionOf(event as Extract<AgentCallEvent, { type: "tool_call" }>)).toEqual({ kind, label });
  });

  it("never names a file outside the worktree", () => {
    expect(actionOf({ name: "Read", kind: "other", input: { file_path: "outside:0123456789abcdef" } }).label).toBe("reading a file outside the worktree");
    expect(actionOf({ name: "Edit", kind: "edit", input: { file_path: "outside:0123456789abcdef", change: "x" } }).label).toBe("editing a file outside the worktree");
  });

  it("leaves out paths a command names outside the worktree", () => {
    expect(redactPaths("cat ~/.ssh/id_rsa && ls /etc")).toBe("cat <outside path> && ls <outside path>");
    expect(redactPaths("cp ./a.ts '/Users/someone/b.ts' --out=/tmp/x")).toBe("cp ./a.ts '<outside path>' --out=<outside path>");
    expect(redactPaths("curl https://example.com/a && pnpm test src/a.ts")).toBe("curl https://example.com/a && pnpm test src/a.ts");
    expect(actionOf({ name: "Bash", kind: "command", input: { command: "cat ~/secrets.txt" } }).label).toBe("running cat <outside path>");
  });

  it("keeps a label on one line, without control characters, and keeps its end when it is too long", () => {
    expect(labelText("pnpm\ttest\n\u001b[31mred‮")).toBe("pnpm test [31mred");
    const long = labelText(`running ${"a".repeat(300)} file.ts`);
    expect(long).toHaveLength(MAX_ACTIVITY_LABEL_CHARS);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith(" file.ts")).toBe(true);
  });
});

describe("activity tracker", () => {
  it("starts thinking at the call's start, then follows turns, text and tool calls", () => {
    const tracker = createActivityTracker(1_000);
    expect(tracker.state()).toEqual({ lastAction: { kind: "think", label: "thinking" }, lastEventAt: 1_000, toolRunning: null });
    tracker.observe({ type: "text", text: "Let me look." }, 2_000);
    expect(tracker.state().lastAction).toEqual({ kind: "think", label: "writing" });
    tracker.observe(tool("t1", "Read", "other", { file_path: "a.ts" }), 3_000);
    expect(tracker.state()).toMatchObject({ lastAction: { kind: "read", label: "reading a.ts" }, lastEventAt: 3_000 });
    tracker.observe({ type: "tool_result", id: "t1" }, 3_500);
    tracker.observe({ type: "turn" }, 4_000);
    expect(tracker.state()).toEqual({ lastAction: { kind: "think", label: "thinking" }, lastEventAt: 4_000, toolRunning: null });
  });

  it("knows the tool that runs from its call to its result, with its own start time", () => {
    const tracker = createActivityTracker(0);
    tracker.observe(tool("t1", "Bash", "command", { command: "pnpm test" }), 10_000);
    expect(tracker.state().toolRunning).toEqual({ label: "running pnpm test", startedAt: 10_000 });
    tracker.observe({ type: "tool_result", id: "other" }, 20_000);
    expect(tracker.state().toolRunning).toEqual({ label: "running pnpm test", startedAt: 10_000 });
    tracker.observe({ type: "tool_result", id: "t1" }, 110_000);
    expect(tracker.state()).toMatchObject({ toolRunning: null, lastEventAt: 110_000 });
  });

  it("shows the latest of tools that run at once, and the earlier one once the latest ends", () => {
    const tracker = createActivityTracker(0);
    tracker.observe(tool("t1", "Bash", "command", { command: "pnpm test" }), 1_000);
    tracker.observe(tool("t2", "Bash", "command", { command: "pnpm lint" }), 2_000);
    expect(tracker.state().toolRunning).toEqual({ label: "running pnpm lint", startedAt: 2_000 });
    tracker.observe({ type: "tool_result", id: "t2" }, 3_000);
    expect(tracker.state().toolRunning).toEqual({ label: "running pnpm test", startedAt: 1_000 });
    tracker.observe({ type: "end", outcome: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 4_000);
    expect(tracker.state().toolRunning).toBeNull();
  });

  it("does not count a plan-usage report as an event of the agent", () => {
    const tracker = createActivityTracker(0);
    expect(tracker.observe({ type: "rate_limit", status: "allowed", windows: [] }, 500_000)).toBe(false);
    expect(tracker.state().lastEventAt).toBe(0);
  });
});

describe("quiet", () => {
  it("is quiet after two minutes without an event, and not before", () => {
    expect(quietForMs({ lastEventAt: 0, toolRunning: null }, QUIET_AFTER_MS - 1)).toBeUndefined();
    expect(quietForMs({ lastEventAt: 0, toolRunning: null }, QUIET_AFTER_MS)).toBe(QUIET_AFTER_MS);
    expect(quietForMs({ lastEventAt: 1_000, toolRunning: null }, 1_000 + 5 * 60_000)).toBe(5 * 60_000);
  });

  it("is never quiet while a tool runs, however long", () => {
    expect(quietForMs({ lastEventAt: 0, toolRunning: { label: "running pnpm test", startedAt: 0 } }, 60 * 60_000)).toBeUndefined();
  });

  it("ends with the next event", () => {
    const tracker = createActivityTracker(0);
    expect(quietForMs(tracker.state(), 3 * 60_000)).toBe(3 * 60_000);
    tracker.observe({ type: "turn" }, 3 * 60_000);
    expect(quietForMs(tracker.state(), 3 * 60_000 + 1)).toBeUndefined();
  });
});
