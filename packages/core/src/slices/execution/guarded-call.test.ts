import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import { type ManualClock, manualClock } from "../../kernel/clock/index.js";
import type { AgentRuntime } from "../../kernel/ports/index.js";
import type { AgentCallEvent } from "../../kernel/schemas/index.js";
import { runGuardedCall } from "./guarded-call.js";
import type { FileState } from "./loop-guard.js";

const USAGE = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const REQUEST = { model: "fake-model", prompt: "fix the bug", cwd: "/tmp/fake" };
const TURN: AgentCallEvent = { type: "turn" };
const MAX_HANG_MS = 10 * 60 * 60 * 1_000;

let callIds = 0;
const call = (kind: "edit" | "command" | "other", name: string, input: Record<string, string | number>): AgentCallEvent => ({
  type: "tool_call",
  id: `t${++callIds}`,
  name,
  kind,
  input,
});
const editFile = (path: string, text: string) => call("edit", "Edit", { file_path: path, new_string: text });
const runTests = () => call("command", "Bash", { command: "npm test" });
const readFile = (path: string, offset = 0) => call("other", "Read", { file_path: path, offset });

/** Lets the guard's async polls finish; uses no time on the clock. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** An event, a pause on the clock, a hang until aborted, or an action such as a file write. */
type Step = AgentCallEvent | { readonly wait: number } | { readonly hang: true } | (() => void);

/** A fake agent that plays `steps` on the clock, then completes. It honours the abort signal. */
function scriptedAgent(clock: ManualClock, steps: readonly Step[]): AgentRuntime {
  const pass = async (ms: number, signal: AbortSignal) => {
    // In small steps, so each poll runs at its own time.
    for (let left = ms; left > 0 && !signal.aborted; left -= 500) {
      clock.advance(Math.min(500, left));
      await settle();
    }
  };
  return {
    async *launch(_request, signal) {
      for (const step of steps) {
        if (signal.aborted) break;
        if (typeof step === "function") step();
        else if ("wait" in step) await pass(step.wait, signal);
        else if ("hang" in step) await pass(MAX_HANG_MS, signal);
        else yield step;
      }
      yield signal.aborted ? { type: "end", outcome: "aborted", usage: USAGE } : { type: "end", outcome: "completed", usage: USAGE };
    },
  };
}

/** A working tree the fake agent writes to, and checks with a fixed result. */
function workTree(clock: ManualClock, checksPass = true) {
  const files = new Map<string, FileState | null>();
  let size = 0;
  return {
    write: (path: string) => () => void files.set(path, { mtimeMs: clock.now(), size: ++size }),
    options: { snapshot: () => Promise.resolve(new Map(files)), checksPass: () => Promise.resolve(checksPass) },
  };
}

const repeat = (times: number, steps: (i: number) => Step[]): Step[] => Array.from({ length: times }, (_, i) => steps(i)).flat();
const live = () => new AbortController().signal;

describe("guarded agent call", () => {
  it("reports the call's activity at its start and after each event of the agent", async () => {
    const clock = manualClock();
    const seen: unknown[] = [];
    const agent = scriptedAgent(clock, [TURN, { wait: 1_000 }, runTests(), { wait: 30_000 }, { type: "tool_result", id: `t${callIds}` }, { type: "rate_limit", status: "allowed", windows: [] }]);
    await runGuardedCall(agent, REQUEST, live(), { clock, onActivity: (activity) => seen.push(activity) });
    expect(seen[0]).toEqual({ lastAction: { kind: "think", label: "thinking" }, lastEventAt: 0, toolRunning: null });
    expect(seen).toContainEqual({ lastAction: { kind: "run", label: "running npm test" }, lastEventAt: 1_000, toolRunning: { label: "running npm test", startedAt: 1_000 } });
    expect(seen).toContainEqual({ lastAction: { kind: "run", label: "running npm test" }, lastEventAt: 31_000, toolRunning: null });
    // Start, turn, tool call, tool result, end: the plan-usage report is not the agent's.
    expect(seen).toHaveLength(5);
  });

  it("stops an agent that keeps reading at the turn cap", async () => {
    const clock = manualClock();
    const agent = scriptedAgent(clock, repeat(40, (i) => [TURN, readFile(`src/f${i}.ts`), { wait: 5_000 }]));
    const { end, guard } = await runGuardedCall(agent, REQUEST, live(), { clock });
    expect(end.outcome).toBe("aborted");
    expect(guard).toMatchObject({ stop: "turn_cap", turns: 30, wastedMs: 145_000, loop: true });
  });

  it("stops an agent that runs the same command again and again at the repeat limit", async () => {
    const clock = manualClock();
    const tree = workTree(clock, false);
    const agent = scriptedAgent(clock, [TURN, editFile("a.ts", "fix"), tree.write("a.ts"), { wait: 12_000 }, ...repeat(10, () => [TURN, runTests(), { wait: 5_000 }])]);
    const { end, guard } = await runGuardedCall(agent, REQUEST, live(), { clock, files: tree.options });
    expect(end.outcome).toBe("aborted");
    expect(guard).toMatchObject({ stop: "repeat_limit", turns: 7, lastChangeAt: 0, wastedMs: 37_000, loop: true });
  });

  it("stops an agent that idles after its change once the checks pass", async () => {
    const clock = manualClock();
    const tree = workTree(clock);
    const agent = scriptedAgent(clock, [TURN, editFile("a.ts", "fix"), tree.write("a.ts"), { wait: 2_000 }, ...repeat(20, (i) => [TURN, readFile("a.ts", i), { wait: 10_000 }])]);
    const { end, guard } = await runGuardedCall(agent, REQUEST, live(), { clock, files: tree.options });
    expect(end.outcome).toBe("aborted");
    expect(guard).toMatchObject({ stop: "idle", lastChangeAt: 0, turnsAfterLastChange: 8, wastedMs: 80_000, loop: true });
    expect(guard.idleWatch).toMatchObject({ checksRun: 1, checksFailed: 0 });
  });

  it("does not idle-stop while the checks fail", async () => {
    const clock = manualClock();
    const tree = workTree(clock, false);
    const agent = scriptedAgent(clock, [TURN, editFile("a.ts", "fix"), tree.write("a.ts"), ...repeat(20, (i) => [TURN, readFile("a.ts", i), { wait: 10_000 }])]);
    const { end, guard } = await runGuardedCall(agent, REQUEST, live(), { clock, files: tree.options });
    expect(end.outcome).toBe("completed");
    expect(guard).toMatchObject({ stop: null, wastedMs: 0 });
    expect(guard.idleWatch).toMatchObject({ checksRun: 1, checksFailed: 1 });
  });

  it("ends a check run still in flight when another guard stops the call", async () => {
    const clock = manualClock();
    const tree = workTree(clock);
    const signals: AbortSignal[] = [];
    const files = {
      snapshot: tree.options.snapshot,
      checksPass: (_timeoutMs: number, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
      },
    };
    const agent = scriptedAgent(clock, [TURN, editFile("a.ts", "fix"), tree.write("a.ts"), ...repeat(20, (i) => [{ wait: 2_000 }, TURN, readFile("a.ts", i)])]);
    const { guard } = await runGuardedCall(agent, REQUEST, live(), { clock, files, settings: { turnCap: 12, repeatLimit: 0, idleMs: 10_000, timeoutMs: 60_000 } });
    expect(guard).toMatchObject({ stop: "turn_cap", turns: 12 });
    expect(guard.idleWatch?.checksRun).toBe(1);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("stops a hung agent at the timeout and counts the whole call as wasted", async () => {
    const clock = manualClock(1_000_000);
    const events: AgentCallEvent[] = [];
    const agent = scriptedAgent(clock, [TURN, runTests(), { hang: true }]);
    const { end, guard } = await runGuardedCall(agent, REQUEST, live(), { clock, onEvent: (event) => events.push(event) });
    expect(clock.now()).toBe(1_600_000);
    expect(end.outcome).toBe("aborted");
    expect(guard).toMatchObject({ stop: "timeout", turns: 1, wastedMs: 600_000, loop: true });
    expect(guard.idleWatch).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["turn", "tool_call", "end"]);
  });

  it("uses the settings it is given", async () => {
    const clock = manualClock();
    const agent = scriptedAgent(clock, [TURN, runTests(), { hang: true }]);
    const { guard } = await runGuardedCall(agent, REQUEST, live(), { clock, settings: { turnCap: 0, repeatLimit: 0, idleMs: 0, timeoutMs: 5_000 } });
    expect(guard).toMatchObject({ stop: "timeout", wastedMs: 5_000 });
  });

  it("records no guard stop when the caller aborts", async () => {
    const clock = manualClock();
    const caller = new AbortController();
    const agent = scriptedAgent(clock, [TURN, runTests(), { wait: 3_000 }, () => caller.abort(), { hang: true }]);
    const { end, guard } = await runGuardedCall(agent, REQUEST, caller.signal, { clock });
    expect(end.outcome).toBe("aborted");
    expect(guard).toMatchObject({ stop: null, wastedMs: 0, loop: false });
  });

  it("keeps the outcome of a call that completed before the stop took effect", async () => {
    const clock = manualClock();
    const deaf: AgentRuntime = {
      async *launch() {
        for (let i = 0; i < 3; i++) yield* [TURN, readFile(`f${i}`)];
        yield { type: "end", outcome: "completed", usage: USAGE };
      },
    };
    const { end, guard } = await runGuardedCall(deaf, REQUEST, live(), { clock, settings: { turnCap: 2, repeatLimit: 0, idleMs: 0, timeoutMs: 60_000 } });
    expect(end.outcome).toBe("completed");
    expect(guard.stop).toBeNull();
  });

  it("keeps the stop when the call fails after it", async () => {
    const clock = manualClock();
    const deaf: AgentRuntime = {
      async *launch() {
        for (let i = 0; i < 3; i++) yield* [TURN, readFile(`f${i}`)];
        yield { type: "end", outcome: "failed", usage: USAGE, error: "killed" };
      },
    };
    const { end, guard } = await runGuardedCall(deaf, REQUEST, live(), { clock, settings: { turnCap: 2, repeatLimit: 0, idleMs: 0, timeoutMs: 60_000 } });
    expect(end.outcome).toBe("failed");
    expect(guard.stop).toBe("turn_cap");
  });

  it("never idle-stops a step without checks", async () => {
    const clock = manualClock();
    const tree = workTree(clock);
    // A step without checks: checksPass answers false.
    const files = { snapshot: tree.options.snapshot, checksPass: () => Promise.resolve(false) };
    const agent = scriptedAgent(clock, [TURN, editFile("a.ts", "fix"), tree.write("a.ts"), ...repeat(50, (i) => [TURN, readFile("a.ts", i), { wait: 10_000 }])]);
    const { guard } = await runGuardedCall(agent, REQUEST, live(), { clock, files, settings: { turnCap: 0, repeatLimit: 0, idleMs: 10_000, timeoutMs: 400_000 } });
    expect(guard.stop).toBe("timeout");
  });

  it("keeps the call's end and usage when the working tree cannot be read", async () => {
    const clock = manualClock();
    const files = { snapshot: () => Promise.reject(new Error("git status failed")), checksPass: () => Promise.resolve(true) };
    const agent = scriptedAgent(clock, [TURN, editFile("a.ts", "fix"), ...repeat(10, (i) => [TURN, readFile("a.ts", i), { wait: 10_000 }])]);
    const { end, guard } = await runGuardedCall(agent, REQUEST, live(), { clock, files });
    expect(end).toEqual({ type: "end", outcome: "completed", usage: USAGE });
    expect(guard).toMatchObject({ stop: null, lastChangeAt: null });
  });

  it("reports a stream without an end event as a failed call", async () => {
    const clock = manualClock();
    const broken: AgentRuntime = { async *launch() {} };
    const { end } = await runGuardedCall(broken, REQUEST, live(), { clock });
    expect(end).toMatchObject({ outcome: "failed", error: expect.any(String) });
  });

  it("lets a long edit and test cycle with one long file write run to the end", async () => {
    const clock = manualClock();
    const tree = workTree(clock);
    const agent = scriptedAgent(clock, [
      TURN,
      readFile("spec.md"),
      { wait: 3_000 },
      TURN,
      editFile("a.ts", "v0"),
      tree.write("a.ts"),
      { wait: 4_000 },
      TURN,
      runTests(),
      { wait: 40_000 },
      // One long file write: the next turn comes only once the whole file is written.
      { wait: 240_000 },
      TURN,
      editFile("big.ts", "a whole new module"),
      tree.write("big.ts"),
      { wait: 3_000 },
      ...repeat(10, (i) => [TURN, editFile("a.ts", `v${i + 1}`), tree.write("a.ts"), { wait: 6_000 }, TURN, runTests(), { wait: 20_000 }]),
      TURN,
      { type: "text", text: "done" },
    ]);
    const { end, guard } = await runGuardedCall(agent, REQUEST, live(), { clock, files: tree.options });
    expect(end.outcome).toBe("completed");
    expect(guard).toMatchObject({ stop: null, turns: 25, wastedMs: 0, loop: false });
    expect(guard.idleWatch?.checksRun).toBe(0);
    expect(guard.idleWatch?.skippedNoActivity).toBeGreaterThan(0);
  });
});
