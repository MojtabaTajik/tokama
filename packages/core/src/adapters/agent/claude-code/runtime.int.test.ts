import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../../../kernel/clock/index.js";
import { createProcessRunner } from "../../../kernel/process/index.js";
import type { AgentCallRequest, AgentRuntime } from "../../../kernel/ports/index.js";
import { describeAgentRuntimeContract } from "../../../kernel/ports/testing/contracts.js";
import type { AgentCallEvent } from "../../../kernel/schemas/index.js";
import { createClaudeCodeRuntime } from "./index.js";

// Runs the adapter against testing/fake-claude.ts through the real process runner. Kill cases
// ported from ai-pipeline tests/test_claude_call.py (timeout, stop, background tools).

const SLOW = { timeout: 20_000 };
const FAKE = join(import.meta.dirname, "testing", "fake-claude.ts");
const runtime = (env?: Record<string, string>): AgentRuntime =>
  createClaudeCodeRuntime({
    command: [process.execPath, FAKE],
    // A short grace keeps the stop tests fast.
    runner: createProcessRunner({ killGraceMs: 200, drainMs: 500 }),
    ...(env !== undefined && { env }),
  });

let dir: string;
const tracked: number[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokama-claude-"));
});
afterEach(() => {
  for (const pid of tracked.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const request = (prompt: string, extra: Partial<AgentCallRequest> = {}): AgentCallRequest => ({
  model: "claude-haiku-5-5",
  prompt,
  cwd: dir,
  timeoutMs: 60_000,
  ...extra,
});

async function collect(stream: AsyncIterable<AgentCallEvent>): Promise<AgentCallEvent[]> {
  const events: AgentCallEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function end(events: AgentCallEvent[]): Extract<AgentCallEvent, { type: "end" }> {
  const last = events.at(-1);
  if (last?.type !== "end") throw new Error(`no end event in ${JSON.stringify(events)}`);
  return last;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeAgentRuntimeContract("claude-code", () => ({
  runtime: runtime(),
  completing: request("success"),
  failing: request("crash"),
  hanging: request("hang"),
}));

describe("Claude Code runtime", SLOW, () => {
  it("starts with the pid, streams the events, and ends with usage, session id and wall time", async () => {
    const events = await collect(runtime().launch(request("success"), new AbortController().signal));
    const [started] = events;
    expect(started?.type).toBe("started");
    expect(events.map((event) => event.type)).toEqual(["started", "rate_limit", "turn", "text", "tool_call", "tool_result", "turn", "text", "tool_call", "tool_result", "turn", "text", "end"]);
    expect(end(events)).toEqual({
      type: "end",
      outcome: "completed",
      usage: { input: 5440, output: 213, cacheRead: 10831, cacheWrite: 0 },
      modelUsage: { "qwen3-coder:30b": { input: 5440, output: 213, cacheRead: 10831, cacheWrite: 0 } },
      costUsd: expect.closeTo(0.0281862, 6),
      sessionId: "d4bc8b9c-641c-40df-bc38-952463fb9366",
      durationMs: expect.any(Number),
    });
  });

  it("runs in the given cwd with the prompt on stdin, the flags, and the allowlisted environment", async () => {
    const events = await collect(
      runtime({ EXTRA_VAR: "1" }).launch(request("echo", { role: "You review code.", limits: { edit: true, commands: ["npm test:*"], web: false } }), new AbortController().signal),
    );
    const said = events.find((event) => event.type === "text");
    if (said?.type !== "text") throw new Error("no text event");
    const echo = JSON.parse(said.text) as { argv: string[]; cwd: string; env: string[]; settings?: { mode: number; text: string; outside: boolean } };
    expect(echo.cwd).toMatch(new RegExp(`${dir.split("/").at(-1) ?? ""}$`));
    expect(echo.argv).toContain("--model=claude-haiku-5-5");
    expect(echo.argv).toContain("Bash(npm test:*)");
    expect(echo.argv).toContain("--append-system-prompt=You review code.");
    expect(echo.env).toContain("EXTRA_VAR");
    // The hook settings sit in a folder of their own outside the worktree, readable by the user only.
    expect(echo.settings).toMatchObject({ mode: 0o700, outside: true });
    expect(JSON.parse(echo.settings?.text ?? "{}")).toMatchObject({ hooks: { PreToolUse: [{ matcher: "Bash" }] } });
    expect(echo.env).not.toContain("SSH_AUTH_SOCK");
    expect(echo.env.every((name) => ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "EXTRA_VAR", "__CF_USER_TEXT_ENCODING"].includes(name))).toBe(true);
  });

  it.each([
    ["logged-out", "auth", "Not logged in · Please run /login"],
    ["quota", "quota", "You've hit your limit · resets 3pm"],
    ["rate-limited", "rate_limit", "API Error: 529 Overloaded. Please try again later."],
  ] as const)("classifies the %s sample as a %s failure", async (prompt, errorKind, error) => {
    const result = end(await collect(runtime().launch(request(prompt), new AbortController().signal)));
    expect(result).toMatchObject({ outcome: "failed", errorKind, error });
    expect(result.sessionId).toEqual(expect.any(String));
  });

  it("reports a crash with stderr when there is no result, and partial usage from the messages", async () => {
    expect(end(await collect(runtime().launch(request("crash"), new AbortController().signal)))).toMatchObject({
      outcome: "failed",
      errorKind: "crash",
      error: "Error: something broke",
    });
    expect(end(await collect(runtime().launch(request("execution-error"), new AbortController().signal)))).toMatchObject({
      outcome: "failed",
      errorKind: "crash",
      usage: { input: 120, output: 30, cacheRead: 1000, cacheWrite: 50 },
    });
  });

  it("reports a CLI that does not start as a crash", async () => {
    const missing = createClaudeCodeRuntime({ command: [join(dir, "no-such-claude")] });
    expect(end(await collect(missing.launch(request("success"), new AbortController().signal)))).toMatchObject({
      outcome: "failed",
      errorKind: "crash",
      error: expect.stringContaining("Claude Code did not start"),
    });
  });

  describe("the version gate for calls with command rules", () => {
    const withCommands = { limits: { edit: false, commands: ["npm test:*"], web: false } };
    const launch = (env: Record<string, string>, extra: Partial<AgentCallRequest>) => collect(runtime(env).launch(request("echo", extra), new AbortController().signal));
    const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    it("refuses a version below 2.1.295 before anything is spawned", async () => {
      const events = await launch({ FAKE_CLAUDE_VERSION: "2.1.294 (Claude Code)" }, withCommands);
      expect(events).toEqual([{ type: "end", outcome: "failed", usage: NO_TOKENS, errorKind: "crash", error: expect.stringMatching(/2\.1\.295.*2\.1\.294/) }]);
    });

    it("runs 2.1.295, with the hook settings", async () => {
      const events = await launch({ FAKE_CLAUDE_VERSION: "2.1.295" }, withCommands);
      expect(end(events).outcome).toBe("completed");
      expect(events.find((event) => event.type === "text")).toMatchObject({ text: expect.stringContaining("--settings=") });
    });

    it("does not gate a call without command rules", async () => {
      const events = await launch({ FAKE_CLAUDE_VERSION: "2.1.294" }, { limits: { edit: false, commands: [], web: false } });
      expect(end(events).outcome).toBe("completed");
    });

    it.each([
      ["garbage", "printed no version"],
      ["exit-3", "exited with code 3"],
    ])("fails closed when `claude --version` says %s", async (version, why) => {
      const events = await launch({ FAKE_CLAUDE_VERSION: version }, withCommands);
      expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "crash", error: expect.stringContaining(why) });
      expect(events).toHaveLength(1);
    });

    it("fails closed when the CLI does not start", async () => {
      const missing = createClaudeCodeRuntime({ command: [join(dir, "no-such-claude")] });
      expect(end(await collect(missing.launch(request("echo", withCommands), new AbortController().signal)))).toMatchObject({
        outcome: "failed",
        errorKind: "crash",
        error: expect.stringContaining("could not read the Claude Code version (`claude --version` did not start)"),
      });
    });
  });

  it("refuses limits it cannot pass safely without starting the CLI", async () => {
    const events = await collect(runtime().launch(request("success", { limits: { edit: false, commands: ["-x"], web: false } }), new AbortController().signal));
    expect(events).toEqual([{ type: "end", outcome: "failed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: expect.any(String), errorKind: "crash" }]);
  });

  it("times out, kills the process group, and reports a timeout", async () => {
    // The timeout runs on a manual clock, advanced once the fake has started its child, so a slow
    // start on CI cannot win the race.
    const clock = manualClock();
    const timed = createClaudeCodeRuntime({ command: [process.execPath, FAKE], runner: createProcessRunner({ clock, killGraceMs: 200, drainMs: 500 }) });
    const events: AgentCallEvent[] = [];
    for await (const event of timed.launch(request("hang-with-child", { timeoutMs: 60_000 }), new AbortController().signal)) {
      events.push(event);
      if (event.type === "text") clock.advance(60_000);
    }
    expect(end(events)).toMatchObject({ outcome: "failed", errorKind: "timeout", sessionId: "44444444-4444-4444-8444-444444444444" });
    const started = events[0];
    const child = events.find((event) => event.type === "text");
    if (started?.type !== "started" || child?.type !== "text") throw new Error("missing events");
    const grandchild = Number(child.text.split(" ")[1]);
    tracked.push(started.pid, grandchild);
    await waitGone(started.pid);
    await waitGone(grandchild);
  });

  it("stops on abort and kills the tools the agent started", async () => {
    const controller = new AbortController();
    const events: AgentCallEvent[] = [];
    for await (const event of runtime().launch(request("hang-with-child"), controller.signal)) {
      events.push(event);
      if (event.type === "text") controller.abort();
    }
    expect(end(events).outcome).toBe("aborted");
    const child = events.find((event) => event.type === "text");
    if (child?.type !== "text") throw new Error("missing child");
    const grandchild = Number(child.text.split(" ")[1]);
    tracked.push(grandchild);
    await waitGone(grandchild);
  });

  it("kills the process group when the caller stops reading", async () => {
    let pid = 0;
    for await (const event of runtime().launch(request("hang"), new AbortController().signal)) {
      if (event.type === "started") {
        pid = event.pid;
        tracked.push(pid);
        break;
      }
    }
    await waitGone(pid);
  });

  /** Runs `prompt` with the stop-after-result grace on a manual clock that a real interval advances. */
  async function withGrace(prompt: string) {
    const clock = manualClock();
    const graced = createClaudeCodeRuntime({ command: [process.execPath, FAKE], clock, resultGraceMs: 10_000, runner: createProcessRunner({ killGraceMs: 200, drainMs: 500 }) });
    const ticker = setInterval(() => clock.advance(1_000), 5);
    try {
      return await collect(graced.launch(request(prompt, { timeoutMs: 600_000 }), new AbortController().signal));
    } finally {
      clearInterval(ticker);
    }
  }

  it("stops a CLI that lingers after a success result, and reports it completed", async () => {
    expect(end(await withGrace("result-then-hang"))).toMatchObject({ outcome: "completed", sessionId: "d4bc8b9c-641c-40df-bc38-952463fb9366" });
  });

  it("stops a CLI that lingers after an error result, and classifies the error, not the stop", async () => {
    expect(end(await withGrace("error-then-hang"))).toMatchObject({ outcome: "failed", errorKind: "auth", error: "Not logged in · Please run /login" });
  });

  it("refuses a request without a timeout, since the runtime owns it", async () => {
    const untimed: AgentCallRequest = { model: "claude-haiku-5-5", prompt: "success", cwd: dir };
    expect(await collect(runtime().launch(untimed, new AbortController().signal))).toEqual([
      { type: "end", outcome: "failed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: "a Claude Code call needs timeoutMs", errorKind: "crash" },
    ]);
  });

  it("sends SIGTERM first on a stop, so Claude Code can stop its own tools", async () => {
    const controller = new AbortController();
    const texts: string[] = [];
    let outcome = "";
    for await (const event of runtime().launch(request("trap-term"), controller.signal)) {
      if (event.type === "text") texts.push(event.text);
      if (event.type === "text" && event.text === "ready") controller.abort();
      if (event.type === "end") outcome = event.outcome;
    }
    expect(texts).toEqual(["ready", "got SIGTERM"]);
    expect(outcome).toBe("aborted");
  });

  it("puts the error subtype in the message and no absolute path", async () => {
    const result = end(await collect(runtime().launch(request("execution-error"), new AbortController().signal)));
    expect(result.error).toBe("error_during_execution");
  });
});
