import { describe, expect, it } from "vitest";
import type { AgentCallEvent } from "../../kernel/schemas/index.js";
import {
  createFileWatch,
  agentCliGuardDefaults,
  createStreamWatch,
  type FileSnapshot,
  type FileState,
  guardReport,
  helperGuardDefaults,
  localModelGuardDefaults,
  LoopGuardSettingsSchema,
  loopGuardSettings,
  pollIntervalMs,
  toolKey,
} from "./loop-guard.js";

const TURN: AgentCallEvent = { type: "turn" };
const command = (id: string, cmd: string, name = "Bash"): AgentCallEvent => ({ type: "tool_call", id, name, kind: "command", input: { command: cmd } });
const edit = (id: string, text: string): AgentCallEvent => ({
  type: "tool_call",
  id,
  name: "Edit",
  kind: "edit",
  input: { file_path: "a.js", old_string: "x", new_string: text },
});
const read = (id: string, offset: number): AgentCallEvent => ({ type: "tool_call", id, name: "Read", kind: "other", input: { file_path: "a.js", offset } });
const live = () => new AbortController().signal;

const settings = (turnCap = 0, repeatLimit = 0) => ({ turnCap, repeatLimit });
/** Feeds a turn and its tool call at `now`, returning the guard's answer to the tool call. */
const turnWith = (watch: ReturnType<typeof createStreamWatch>, call: AgentCallEvent, now: number) => {
  watch.observe(TURN, now);
  return watch.observe(call, now);
};

describe("loop guard settings", () => {
  it("has defaults per runtime, each within the bounds", () => {
    expect(localModelGuardDefaults).toEqual({ turnCap: 30, repeatLimit: 6, idleMs: 75_000, silentMs: 300_000, toolSilentMs: 1_200_000, timeoutMs: 600_000 });
    expect(agentCliGuardDefaults).toEqual({ turnCap: 150, repeatLimit: 6, idleMs: 180_000, silentMs: 600_000, toolSilentMs: 1_200_000, timeoutMs: 5_400_000 });
    for (const defaults of [localModelGuardDefaults, agentCliGuardDefaults]) expect(LoopGuardSettingsSchema.safeParse(defaults).success).toBe(true);
  });

  it("applies overrides over the local-model defaults, or over the defaults it is given", () => {
    expect(loopGuardSettings({ turnCap: 80, idleMs: 0 })).toEqual({ ok: true, value: { turnCap: 80, repeatLimit: 6, idleMs: 0, silentMs: 300_000, toolSilentMs: 1_200_000, timeoutMs: 600_000 } });
    expect(loopGuardSettings({ repeatLimit: 0 }, agentCliGuardDefaults)).toEqual({ ok: true, value: { ...agentCliGuardDefaults, repeatLimit: 0 } });
    expect(loopGuardSettings(undefined, agentCliGuardDefaults)).toEqual({ ok: true, value: agentCliGuardDefaults });
  });

  it.each([
    [{ timeoutMs: 0 }],
    [{ timeoutMs: 2_147_483_648 }],
    [{ turnCap: -1 }],
    [{ repeatLimit: 1.5 }],
    [{ repeatLimit: 1 }],
    [{ idleMs: 9_999 }],
    [{ silentMs: -1 }],
    [{ silentMs: 9_999 }],
    [{ silentMs: 2_147_483_648 }],
    [{ toolSilentMs: -1 }],
    [{ toolSilentMs: 9_999 }],
    [{ toolSilentMs: 2_147_483_648 }],
    [{ idle: 10 }],
    [null],
  ])("refuses %j", (overrides) => {
    expect(loopGuardSettings(overrides).ok).toBe(false);
  });

  it("takes the bounds themselves", () => {
    expect(loopGuardSettings({ timeoutMs: 2_147_483_647, repeatLimit: 2, idleMs: 10_000, silentMs: 10_000 }).ok).toBe(true);
    expect(loopGuardSettings({ silentMs: 2_147_483_647 }).ok).toBe(true);
    expect(loopGuardSettings({ toolSilentMs: 10_000 }).ok).toBe(true);
    expect(loopGuardSettings({ toolSilentMs: 2_147_483_647 }).ok).toBe(true);
  });

  it("takes silentMs 0, which turns the silence stop off", () => {
    expect(loopGuardSettings({ silentMs: 0 }, agentCliGuardDefaults)).toEqual({ ok: true, value: { ...agentCliGuardDefaults, silentMs: 0 } });
  });

  it("takes toolSilentMs 0, which turns the tool silence stop off", () => {
    expect(loopGuardSettings({ toolSilentMs: 0 }, agentCliGuardDefaults)).toEqual({ ok: true, value: { ...agentCliGuardDefaults, toolSilentMs: 0 } });
  });
});

describe("stream watch", () => {
  it("counts a tool call streamed twice once", () => {
    const watch = createStreamWatch(settings(0, 2));
    watch.observe(TURN, 1);
    expect(watch.observe(command("t1", "ls"), 1.1)).toBeUndefined();
    expect(watch.observe(command("t1", "ls"), 1.2)).toBeUndefined();
    expect(watch.turns()).toBe(1);
    expect(turnWith(watch, command("t2", "ls"), 2)).toBe("repeat_limit");
    expect(watch.turns()).toBe(2);
  });

  it("needs identical input for a repeat", () => {
    const watch = createStreamWatch(settings(0, 2));
    expect(turnWith(watch, command("t1", "ls a"), 1)).toBeUndefined();
    expect(turnWith(watch, command("t2", "ls b"), 2)).toBeUndefined();
    expect(turnWith(watch, command("t3", "ls a", "Shell"), 3)).toBeUndefined();
    expect(turnWith(watch, command("t4", "ls a"), 4)).toBe("repeat_limit");
  });

  it("stops only a turn that asks for more at the turn cap", () => {
    let watch = createStreamWatch(settings(2));
    expect(turnWith(watch, command("t1", "a"), 1)).toBeUndefined();
    expect(watch.observe(TURN, 2)).toBeUndefined();
    expect(watch.observe({ type: "text", text: "done" }, 2)).toBeUndefined();
    watch = createStreamWatch(settings(2));
    turnWith(watch, command("t1", "a"), 1);
    expect(turnWith(watch, command("t2", "b"), 2)).toBe("turn_cap");
  });

  it("starts the repeat counts again on a new edit, not on an identical one", () => {
    let watch = createStreamWatch(settings(0, 3));
    // edit, test, edit, test, each edit different: work.
    for (let i = 0; i < 10; i++) {
      expect(turnWith(watch, edit(`e${i}`, `v${i}`), i)).toBeUndefined();
      expect(turnWith(watch, command(`b${i}`, "npm test"), i)).toBeUndefined();
    }
    watch = createStreamWatch(settings(0, 3));
    expect([0, 1, 2].map((i) => turnWith(watch, edit(`e${i}`, "same"), i))).toEqual([undefined, undefined, "repeat_limit"]);
  });

  it("keys on input regardless of key order, and on every input field", () => {
    expect(toolKey({ name: "Read", input: { file_path: "a.js", offset: 1 } })).toBe(toolKey({ name: "Read", input: { offset: 1, file_path: "a.js" } }));
    const watch = createStreamWatch(settings(0, 2));
    expect(turnWith(watch, read("t1", 1), 1)).toBeUndefined();
    expect(turnWith(watch, read("t2", 50), 2)).toBeUndefined();
    expect(turnWith(watch, read("t3", 1), 3)).toBe("repeat_limit");
  });

  it("does not throw on input nested too deep to walk", () => {
    let deep: unknown = [];
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const call = { type: "tool_call", id: "t1", name: "X", kind: "other", input: { deep } } as unknown as Extract<AgentCallEvent, { type: "tool_call" }>;
    expect(toolKey(call)).toBe("X\n<unserializable>");
    expect(createStreamWatch(settings(0, 2)).observe(call, 1)).toBeUndefined();
  });

  it("is off when the limits are 0", () => {
    const watch = createStreamWatch(settings(0, 0));
    for (let i = 0; i < 100; i++) expect(turnWith(watch, command(`t${i}`, "ls"), i)).toBeUndefined();
  });
});

describe("file watch", () => {
  const state = (mtimeMs: number, size: number): FileState => ({ mtimeMs, size });

  const setup = async (idleMs: number, extra: { turnsAfter?: (at: number) => number; turns?: () => number; onChange?: () => void } = {}) => {
    const box = { snap: new Map() as FileSnapshot | undefined, passes: true, checkCalls: [] as number[], checks: undefined as (() => boolean) | undefined };
    const watch = await createFileWatch(
      {
        snapshot: () => Promise.resolve(box.snap && new Map(box.snap)),
        checksPass: (timeoutMs) => {
          box.checkCalls.push(timeoutMs);
          return Promise.resolve(box.checks ? box.checks() : box.passes);
        },
        idleMs,
        ...extra,
      },
      0,
    );
    return { box, watch };
  };

  it("stops when idle after a change and the checks pass", async () => {
    const { box, watch } = await setup(10_000);
    expect(await watch.poll(5_000, 100_000, live())).toBeUndefined(); // no change yet: never stop
    expect(await watch.poll(20_000, 100_000, live())).toBeUndefined();
    box.snap = new Map([["a.js", state(21_000, 5)]]);
    expect(await watch.poll(22_000, 100_000, live())).toBeUndefined();
    expect(watch.lastChangeAt()).toBe(21_000); // from the file's mtime
    expect(await watch.poll(30_000, 100_000, live())).toBeUndefined(); // 9 s quiet
    expect(await watch.poll(32_000, 100_000, live())).toBe("idle");
    expect(box.checkCalls).toEqual([68_000]); // the checks get the time left before the deadline
  });

  it("after failed checks, waits for a new change", async () => {
    const { box, watch } = await setup(10_000);
    box.snap = new Map([["a.js", state(1_000, 5)]]);
    await watch.poll(2_000, 1_000_000, live());
    box.passes = false;
    expect(await watch.poll(20_000, 1_000_000, live())).toBeUndefined();
    expect(await watch.poll(40_000, 1_000_000, live())).toBeUndefined();
    expect(box.checkCalls).toHaveLength(1);
    box.passes = true;
    box.snap = new Map([["a.js", state(45_000, 6)]]);
    expect(await watch.poll(46_000, 1_000_000, live())).toBeUndefined();
    expect(await watch.poll(56_000, 1_000_000, live())).toBe("idle");
    expect(box.checkCalls).toHaveLength(2);
  });

  it("ignores files the checks write, from then on", async () => {
    const { box, watch } = await setup(10_000);
    box.snap = new Map([["a.js", state(1_000, 5)]]);
    await watch.poll(2_000, 1_000_000, live());
    box.checks = () => {
      box.snap = new Map([
        ["a.js", state(1_000, 5)],
        ["report.txt", state(15_000, 1)],
      ]);
      return false;
    };
    expect(await watch.poll(15_000, 1_000_000, live())).toBeUndefined(); // checks failed
    expect(watch.lastChangeAt()).toBe(1_000); // check-written files are not the agent's changes
    expect(watch.stats().checkTouchedFiles).toEqual(["report.txt"]);
    box.snap = new Map([
      ["a.js", state(20_000, 6)],
      ["report.txt", state(21_000, 2)],
    ]);
    expect(await watch.poll(21_000, 1_000_000, live())).toBeUndefined();
    expect(watch.lastChangeAt()).toBe(20_000); // report.txt is ignored now
    box.checks = () => {
      box.snap = new Map([
        ["a.js", state(20_000, 6)],
        ["report.txt", state(31_000, 3)],
      ]);
      return true;
    };
    expect(await watch.poll(31_000, 1_000_000, live())).toBe("idle");
    expect(watch.stats()).toMatchObject({ checksRun: 2, checksFailed: 1 });
  });

  it("does not stop one long write: needs turns after the change", async () => {
    let turns = 0;
    const { box, watch } = await setup(10_000, { turnsAfter: () => turns });
    box.snap = new Map([["big.js", state(1_000, 5)]]);
    await watch.poll(2_000, 1_000_000, live());
    expect(await watch.poll(20_000, 1_000_000, live())).toBeUndefined(); // no turns since the change
    turns = 1;
    expect(await watch.poll(30_000, 1_000_000, live())).toBeUndefined();
    expect(watch.stats()).toMatchObject({ skippedNoActivity: 2, checksRun: 0 });
    turns = 2;
    expect(await watch.poll(40_000, 1_000_000, live())).toBe("idle");
  });

  it("starts the repeat counts again on a file change", async () => {
    const stream = createStreamWatch(settings(0, 3));
    const { box, watch } = await setup(0, { onChange: stream.resetRepeats });
    turnWith(stream, command("t1", "npm test"), 1);
    turnWith(stream, command("t2", "npm test"), 2);
    box.snap = new Map([["a.js", state(3_000, 1)]]);
    await watch.poll(3_000, 100_000, live());
    expect(turnWith(stream, command("t3", "npm test"), 4)).toBeUndefined();
    expect(turnWith(stream, command("t4", "npm test"), 5)).toBeUndefined();
    expect(turnWith(stream, command("t5", "npm test"), 6)).toBe("repeat_limit");
  });

  it("tracks changes with the idle stop off", async () => {
    const { box, watch } = await setup(0);
    box.snap = new Map([["a.js", null]]); // deleted: no mtime, so the time of the poll
    expect(await watch.poll(7_000, 100_000, live())).toBeUndefined();
    expect(watch.lastChangeAt()).toBe(7_000);
    expect(await watch.poll(500_000, 1_000_000, live())).toBeUndefined();
    expect(box.checkCalls).toEqual([]);
  });

  it("counts edits made during a check run as the agent's, and ignores that run's result", async () => {
    let turns = 3;
    const { box, watch } = await setup(10_000, { turns: () => turns });
    box.snap = new Map([["a.js", state(1_000, 5)]]);
    await watch.poll(2_000, 1_000_000, live());
    box.checks = () => {
      // The agent edits b.js in a new turn while the checks run.
      turns++;
      box.snap = new Map([
        ["a.js", state(1_000, 5)],
        ["b.js", state(16_000, 1)],
      ]);
      return true;
    };
    expect(await watch.poll(15_000, 1_000_000, live())).toBeUndefined();
    expect(watch.lastChangeAt()).toBe(15_000); // the poll's time: the edit came after it started
    expect(watch.stats()).toMatchObject({ checksRun: 1, checkTouchedFiles: [] });
    box.checks = undefined;
    expect(await watch.poll(30_000, 1_000_000, live())).toBe("idle"); // a new quiet period, checks again
  });

  it("runs the checks again after a run during which the agent took a turn but changed nothing", async () => {
    let turns = 3;
    const { box, watch } = await setup(10_000, { turns: () => turns });
    box.snap = new Map([["a.js", state(1_000, 5)]]);
    await watch.poll(2_000, 1_000_000, live());
    box.checks = () => {
      turns++;
      return true;
    };
    expect(await watch.poll(15_000, 1_000_000, live())).toBeUndefined(); // stale: a turn during the run
    expect(watch.lastChangeAt()).toBe(1_000);
    box.checks = undefined;
    expect(await watch.poll(20_000, 1_000_000, live())).toBe("idle");
    expect(watch.stats()).toMatchObject({ checksRun: 2 });
  });

  it("treats a snapshot that throws as one that failed", async () => {
    const box = { fail: true };
    const watch = await createFileWatch(
      {
        snapshot: () => (box.fail ? Promise.reject(new Error("git status failed")) : Promise.resolve(new Map([["a.js", state(1_000, 1)]]))),
        checksPass: () => Promise.resolve(true),
        idleMs: 10_000,
      },
      0,
    );
    expect(await watch.poll(5_000, 100_000, live())).toBeUndefined();
    await watch.finish(6_000);
    expect(watch.lastChangeAt()).toBeNull();
    box.fail = false;
    await watch.poll(7_000, 100_000, live());
    expect(watch.lastChangeAt()).toBe(1_000); // the start used an empty map
  });

  it("skips a snapshot that failed", async () => {
    const { box, watch } = await setup(10_000);
    box.snap = undefined;
    expect(await watch.poll(5_000, 100_000, live())).toBeUndefined();
    expect(watch.lastChangeAt()).toBeNull();
  });
});

describe("guard report", () => {
  it("measures the time after the last change and marks loops", async () => {
    const stream = createStreamWatch(settings());
    for (const at of [1_000, 2_000, 5_000, 6_000]) stream.observe(TURN, at);
    const box = { snap: new Map<string, FileState | null>() };
    const files = await createFileWatch({ snapshot: () => Promise.resolve(new Map(box.snap)), checksPass: () => Promise.resolve(true), idleMs: 0 }, 0);
    box.snap.set("a.js", { mtimeMs: 3_000, size: 1 });
    await files.finish(4_000);

    const idle = guardReport(stream, files, 0, 10_000, "idle");
    expect(idle).toMatchObject({ stop: "idle", turns: 4, turnsAfterLastChange: 2, msAfterLastChange: 7_000, lastChangeAt: 3_000, wastedMs: 7_000, loop: false });
    expect(idle.idleWatch).toEqual({ checksRun: 0, checksFailed: 0, skippedNoActivity: 0, checkTouchedFiles: [] });
    for (const at of [7_000, 7_100, 7_200, 7_300]) stream.observe(TURN, at);
    expect(guardReport(stream, files, 0, 10_000, "idle").loop).toBe(true); // 6 turns after the change
    for (const stop of ["turn_cap", "repeat_limit", "timeout"] as const) expect(guardReport(stream, files, 0, 10_000, stop).loop).toBe(true);
    // A frozen CLI wastes the time too, but it is not a loop.
    for (const stop of ["silent", "tool_silent"] as const) expect(guardReport(stream, files, 0, 10_000, stop)).toMatchObject({ loop: false, wastedMs: 7_000 });
    expect(guardReport(stream, files, 0, 10_000, null)).toMatchObject({ loop: false, wastedMs: 0, msAfterLastChange: 7_000 });
  });

  it("counts the whole call when no file changed", () => {
    const stream = createStreamWatch(settings());
    for (const at of [1_000, 2_000, 5_000, 6_000]) stream.observe(TURN, at);
    const report = guardReport(stream, undefined, 0, 10_000, "timeout");
    expect(report).toEqual({ stop: "timeout", turns: 4, turnsAfterLastChange: 4, msAfterLastChange: 10_000, lastChangeAt: null, wastedMs: 10_000, loop: true });
  });

  it("polls every 10 s, or a quarter of a shorter idle window", () => {
    expect(pollIntervalMs(75_000)).toBe(10_000);
    expect(pollIntervalMs(2_000)).toBe(500);
    expect(pollIntervalMs(0)).toBe(10_000);
  });

  it("has helper settings that are valid, with no idle stop and the helper's own time", () => {
    expect(helperGuardDefaults(90_000)).toEqual({ turnCap: 3, repeatLimit: 3, idleMs: 0, silentMs: 60_000, toolSilentMs: 60_000, timeoutMs: 90_000 });
    expect(LoopGuardSettingsSchema.safeParse(helperGuardDefaults(300_000)).success).toBe(true);
  });
});
