// Stored items to API item records, on logs written by the real item store.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DecisionId, ItemStore, loadHostId, manualClock, parseItemRecord, parseTemplateRecord, type StepId, type StoredItem, type TemplateRecord } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toItemRecord } from "./records.js";

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
const FIX = "fix" as StepId;
const REVIEW = "review" as StepId;
const DECISION = "decision_0190a000-0000-7000-8000-00000000000d" as DecisionId;
const COMMIT = "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567";

let home: string;
let store: ItemStore;
let clock: ReturnType<typeof manualClock>;

interface Shape {
  /** The names of the two steps. */
  readonly names?: readonly [string, string];
  readonly finish?: readonly string[];
  readonly budget?: number;
}

function template(shape: Shape = {}): TemplateRecord {
  const names = shape.names ?? ["Fix", "Review"];
  const step = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: id === "fix" ? names[0] : names[1],
    agentId: id === "fix" ? "builder" : "reviewer",
    instructions: { text: "Do it." },
    doneWhen: "agent finishes",
    ifFailed: { action: "ask" },
    maxAttempts: 3,
    data: "none",
    sees: [],
    connections: [],
    commands: [],
    ...extra,
  });
  const parsed = parseTemplateRecord({
    schemaVersion: 2,
    ref: "orders-api/careful-fix",
    id: "careful-fix",
    source: { kind: "repo", repoId: "orders-api", file: ".tokama/templates/careful-fix.yaml" },
    name: "Careful fix",
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    finish: shape.finish ?? ["commit"],
    ...(shape.budget !== undefined && { budget: { timeMinutes: shape.budget } }),
    steps: [step("fix", { doneWhen: "checks pass", checks: { from: "repo" }, data: "repo-and-diff" }), step("review", { doneWhen: "reviewer approves", ifChangesRequested: { action: "ask" } })],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

function created(shape: Shape = {}): StoredItem {
  const made = store.create({ template: template(shape), title: "Fix the greeting", text: "Fix the greeting\nIt says helo.", repoIds: ["orders-api" as never] });
  if (!made.ok) throw new Error(made.error.message);
  return made.value;
}

function append(item: StoredItem, events: Parameters<ItemStore["append"]>[1]): StoredItem {
  const appended = store.append(item.id, events);
  if (!appended.ok) throw new Error(appended.error.message);
  return appended.value;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tk-records-"));
  const hostId = loadHostId(home);
  if (!hostId.ok) throw new Error(hostId.error);
  clock = manualClock(T0);
  store = ItemStore.open({ home, hostId: hostId.value, clock }).store;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("toItemRecord", () => {
  it("times each ended attempt, step and the ended item from the log, with the time it waited for you apart, also after a restart", () => {
    const at = (ms: number, events: Parameters<ItemStore["append"]>[1]) => (item: StoredItem) => {
      clock.advance(ms);
      return append(item, events);
    };
    const steps: Array<(item: StoredItem) => StoredItem> = [
      at(10_000, [{ type: "step_started", stepId: FIX }, { type: "attempt_started", stepId: FIX, attempt: 1 }]),
      at(185_000, [{ type: "attempt_ended", stepId: FIX, attempt: 1, result: "failed" }, { type: "attempt_started", stepId: FIX, attempt: 2 }]),
      // Attempt 2 asks about a protected change after a minute; you answer 6 minutes later.
      at(60_000, [{ type: "decision_opened", decisionId: DECISION, kind: "tamper", stepId: FIX, choices: [{ id: "approve", label: "Approve" }] }]),
      at(360_000, [{ type: "decision_resolved", decisionId: DECISION, choice: "approve" }]),
      at(192_000, [{ type: "attempt_ended", stepId: FIX, attempt: 2, result: "passed" }, { type: "step_ended", stepId: FIX, result: "passed" }]),
      at(2_000, [{ type: "step_started", stepId: REVIEW }, { type: "attempt_started", stepId: REVIEW, attempt: 1 }]),
    ];
    const running = steps.reduce((item, step) => step(item), created());
    const live = toItemRecord(running)!;
    expect(live.durationMs).toBeUndefined();
    expect(live.steps[1]).toMatchObject({ state: "running", attempts: [{ attempt: 1, startedAt: clock.now() }] });
    expect(live.steps[1]!.attempts![0]).not.toHaveProperty("durationMs");
    expect(live.steps[1]).not.toHaveProperty("durationMs");

    const ended = at(252_000, [
      { type: "attempt_ended", stepId: REVIEW, attempt: 1, result: "passed" },
      { type: "step_ended", stepId: REVIEW, result: "passed" },
      { type: "item_ended", outcome: "done" },
    ])(running);
    const check = (record: ReturnType<typeof toItemRecord>) => {
      const [fix, review] = record!.steps;
      expect(fix!.attempts!.map((attempt) => attempt.durationMs)).toEqual([185_000, 252_000]);
      expect(fix).toMatchObject({ durationMs: 437_000, waitedMs: 360_000 });
      expect(review).toMatchObject({ durationMs: 252_000, attempts: [{ startedAt: T0 + 809_000, endedAt: T0 + 1_061_000, durationMs: 252_000 }] });
      expect(review).not.toHaveProperty("waitedMs");
      // First attempt start to the end, less the 6 minutes it waited for you.
      expect(record!.durationMs).toBe(1_051_000 - 360_000);
    };
    check(toItemRecord(ended));
    // A restart folds the same log again: the same figures.
    const reopened = ItemStore.open({ home, hostId: ended.hostId, clock: manualClock(T0 + 99 * 3_600_000) }).store;
    check(toItemRecord(reopened.get(ended.id)!));
  });

  it("does not count the time the engine was down as working time", () => {
    let item = append(created(), [{ type: "step_started", stepId: FIX }, { type: "attempt_started", stepId: FIX, attempt: 1 }]);
    // The engine stops during the attempt and comes back 15 hours later; recovery ends the attempt then.
    clock.advance(15 * 3_600_000);
    item = append(item, [{ type: "attempt_ended", stepId: FIX, attempt: 1, result: "run_failed", failure: "engine_restart" }, { type: "attempt_started", stepId: FIX, attempt: 2 }]);
    clock.advance(252_000);
    item = append(item, [{ type: "attempt_ended", stepId: FIX, attempt: 2, result: "passed" }, { type: "step_ended", stepId: FIX, result: "passed" }, { type: "item_ended", outcome: "stopped" }]);
    const record = toItemRecord(item)!;
    expect(record.steps[0]!.attempts!.map((attempt) => attempt.durationMs)).toEqual([undefined, 252_000]);
    expect(record.steps[0]!.durationMs).toBe(252_000);
    expect(record.durationMs).toBe(252_000);
  });

  it("maps a new item from its template snapshot: ref, kind, privacy and every step pending", () => {
    const record = toItemRecord(created())!;
    expect(record).toMatchObject({ templateId: "orders-api/careful-fix", kind: "task", privacy: "local_and_cloud", state: "queued", title: "Fix the greeting", cardLine: "starting" });
    expect(record.steps).toEqual([
      { name: "Fix", stage: "working", state: "pending", agentId: "builder", data: "repo-and-diff", runs: 0, maxAttempts: 3 },
      { name: "Review", stage: "review", state: "pending", agentId: "reviewer", data: "none", runs: 0, maxAttempts: 3 },
    ]);
  });

  it("reads a stored version 1 snapshot: step names and agents come from it", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "packages", "core", "src", "kernel", "schemas", "testing", "fixtures", "template-snapshot-v1.json"), "utf8")) as { record: unknown };
    const parsed = parseTemplateRecord(fixture.record);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    const made = store.create({ template: parsed.value, title: "Fix the greeting", text: "Fix the greeting", repoIds: ["orders-api" as never] });
    if (!made.ok) throw new Error(made.error.message);
    expect(toItemRecord(made.value)!.steps.map((step) => [step.name, step.agentId])).toEqual([["Plan", "architect"], ["Build", "builder"], ["Review", "reviewer"]]);
  });

  it("does not throw on a snapshot a newer Tokama wrote: step names fall back to the ids", () => {
    const made = store.create({ template: { ...template(), schemaVersion: 99 } as never, title: "Fix the greeting", text: "Fix the greeting", repoIds: ["orders-api" as never] });
    if (!made.ok) throw new Error(made.error.message);
    const record = toItemRecord(made.value)!;
    expect(record.steps.map((step) => step.name)).toEqual(["fix", "review"]);
    expect(record.steps.every((step) => step.agentId === undefined)).toBe(true);
  });

  it("shows a checks step as verifying while its checks run, with the attempt and its count", () => {
    let item = append(created(), [
      { type: "step_started", stepId: FIX },
      { type: "attempt_started", stepId: FIX, attempt: 1 },
    ]);
    expect(toItemRecord(item)!.steps[0]).toMatchObject({ stage: "working", state: "running", detail: "attempt 1 of 3", attempts: [{ attempt: 1, checks: [] }] });
    item = append(item, [{ type: "process_started", stepId: FIX, attempt: 1, role: "check", pid: 4242, bootTime: T0 }]);
    expect(toItemRecord(item)).toMatchObject({ cardLine: "Fix · attempt 1 of 3", steps: [{ stage: "verifying" }, {}] });
  });

  it("counts the runs of the current round: a step the work came back to starts again from run 1", () => {
    let item = append(created(), [
      { type: "step_started", stepId: FIX },
      { type: "attempt_started", stepId: FIX, attempt: 1 },
      { type: "attempt_ended", stepId: FIX, attempt: 1, result: "failed" },
      { type: "attempt_started", stepId: FIX, attempt: 2 },
      { type: "attempt_ended", stepId: FIX, attempt: 2, result: "passed" },
      { type: "step_ended", stepId: FIX, result: "passed" },
      { type: "step_started", stepId: REVIEW },
      { type: "attempt_started", stepId: REVIEW, attempt: 1 },
      { type: "attempt_ended", stepId: REVIEW, attempt: 1, result: "failed" },
      { type: "step_ended", stepId: REVIEW, result: "failed" },
      { type: "step_started", stepId: FIX },
    ]);
    expect(toItemRecord(item)!.steps[0]).toMatchObject({ state: "running", detail: "starting", runs: 0, maxAttempts: 3 });
    item = append(item, [{ type: "attempt_started", stepId: FIX, attempt: 3 }]);
    expect(toItemRecord(item)!.steps[0]).toMatchObject({ detail: "attempt 1 of 3", runs: 1, maxAttempts: 3 });
  });

  it("serves an open decision with its kind, step and choices, and a detail cut to fit", () => {
    const long = `The agent call timed out. ${"x".repeat(600)}`;
    const item = append(created(), [
      { type: "step_started", stepId: FIX },
      { type: "attempt_started", stepId: FIX, attempt: 1 },
      { type: "attempt_ended", stepId: FIX, attempt: 1, result: "run_failed", failure: "timeout", detail: long.slice(0, 500) },
      { type: "decision_opened", decisionId: DECISION, kind: "run_failure", stepId: FIX, choices: [{ id: "retry_step", label: "Retry step" }, { id: "stop", label: "Stop" }], detail: long.slice(0, 500) },
    ]);
    const record = toItemRecord(item)!;
    expect(record.state).toBe("needs_you");
    expect(record.decision).toMatchObject({ id: DECISION, kind: "run_failure", stepIndex: 0, question: "Fix could not run. Run Fix again?", choices: [{ id: "retry_step" }, { id: "stop" }] });
    expect(record.decision!.why!.length).toBeLessThanOrEqual(500);
    expect(record.steps[0]).toMatchObject({ state: "needs_you", detail: "waits for you", attempts: [{ result: "run_failed", failure: "timeout" }] });
    expect(parseItemRecord(record).ok).toBe(true);
  });

  it("explains a step that stopped at its limit, and names the step on the button that runs it again", () => {
    const item = append(created(), [
      { type: "step_started", stepId: FIX },
      { type: "attempt_started", stepId: FIX, attempt: 1 },
      { type: "check_result", stepId: FIX, attempt: 1, command: "pnpm test", exitCode: 0, passed: true },
      { type: "attempt_ended", stepId: FIX, attempt: 1, result: "passed" },
      { type: "step_ended", stepId: FIX, result: "passed" },
      { type: "step_started", stepId: REVIEW },
      { type: "attempt_started", stepId: REVIEW, attempt: 1 },
      { type: "attempt_ended", stepId: REVIEW, attempt: 1, result: "failed", detail: "The reviewer asked for changes." },
      // A log from before the card: the button still said Retry once more.
      { type: "decision_opened", decisionId: DECISION, kind: "after_failure", stepId: REVIEW, choices: [{ id: "one_more_attempt", label: "Retry once more" }, { id: "no_action_needed", label: "End: no action needed" }, { id: "stop", label: "Stop" }], detail: "Step Review reached its limit of 3 attempts." },
    ]);
    const record = toItemRecord(item)!;
    expect(record.decision).toMatchObject({
      kind: "after_failure",
      stepIndex: 1,
      why: "Step Review reached its limit of 3 attempts.",
      stopped: { limit: true, then: { kind: "none" }, why: "Review may run 3 times per round." },
      choices: [{ id: "one_more_attempt", label: "Run Review again" }, { label: "End: no action needed" }, { label: "Stop" }],
    });
    expect(parseItemRecord(record).ok).toBe(true);
  });

  it("counts runs as the engine does, and carries the Request changes note only while the step runs again", () => {
    const TREE = "a".repeat(40);
    const asked = (id: string, choices: { id: string; label: string }[]) => ({ type: "decision_opened" as const, decisionId: id as never, kind: "plan_approval" as const, stepId: FIX, choices, tree: TREE });
    const approval = [{ id: "approve", label: "Approve" }, { id: "request_changes", label: "Request changes" }];
    const FIRST = "decision_00000000-0000-4000-8000-0000000000f1";
    const SECOND = "decision_00000000-0000-4000-8000-0000000000f2";
    let item = append(created(), [
      { type: "step_started", stepId: FIX },
      { type: "attempt_started", stepId: FIX, attempt: 1 },
      { type: "attempt_ended", stepId: FIX, attempt: 1, result: "passed" },
      asked(FIRST, approval),
      { type: "decision_resolved", decisionId: FIRST as never, choice: "request_changes", note: "Keep the old name." },
      { type: "attempt_started", stepId: FIX, attempt: 2 },
    ]);
    expect(toItemRecord(item)!.steps[0]).toMatchObject({ state: "running", runs: 2, maxAttempts: 3, changesNote: "Keep the old name." });
    // The running attempt counts; a run failure does not. Once it is answered, the note is no longer the latest answer.
    item = append(item, [
      { type: "attempt_ended", stepId: FIX, attempt: 2, result: "run_failed", failure: "timeout" },
      { type: "decision_opened", decisionId: SECOND as never, kind: "run_failure", stepId: FIX, choices: [{ id: "retry_step", label: "Retry step" }] },
      { type: "decision_resolved", decisionId: SECOND as never, choice: "retry_step" },
      { type: "attempt_started", stepId: FIX, attempt: 3 },
    ]);
    const step = toItemRecord(item)!.steps[0]!;
    expect(step).toMatchObject({ state: "running", runs: 2, maxAttempts: 3 });
    expect(step.changesNote).toBeUndefined();
  });

  it("places a decision with no step at the step the item is in", () => {
    const item = append(created(), [{ type: "decision_opened", decisionId: DECISION, kind: "run_failure", choices: [{ id: "retry_step", label: "Check again" }], detail: "The setup command failed." }]);
    expect(toItemRecord(item)!.decision).toMatchObject({ stepIndex: 0, why: "The setup command failed." });
  });

  it("serves the commit and branch of a done item", () => {
    const item = append(created(), [
      { type: "worktree_added", repoId: "orders-api" as never, branch: "tokama/0b9f3c1e", dir: ".tokama/wt/item-0b9f3c1e", baseCommit: COMMIT },
      { type: "step_started", stepId: FIX },
      { type: "step_ended", stepId: FIX, result: "passed" },
      { type: "step_started", stepId: REVIEW },
      { type: "step_ended", stepId: REVIEW, result: "passed" },
      { type: "item_ended", outcome: "done", detail: "Committed.", commits: [{ repoId: "orders-api" as never, commit: COMMIT }] },
    ]);
    expect(toItemRecord(item)).toMatchObject({
      state: "done",
      cardLine: "commit 3f2a9c1 · tokama/0b9f3c1e",
      outcome: { kind: "done", detail: "Committed.", commits: [{ repoId: "orders-api", commit: COMMIT, branch: "tokama/0b9f3c1e" }] },
    });
  });

  describe("the question each kind of decision asks", () => {
    const TREE = "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766";
    const BOTH = [{ id: "approve", label: "Approve" }, { id: "request_changes", label: "Request changes" }, { id: "no_action_needed", label: "End: no action needed" }, { id: "stop", label: "Stop" }];
    const START = [{ type: "step_started", stepId: FIX }, { type: "attempt_started", stepId: FIX, attempt: 1 }, { type: "attempt_ended", stepId: FIX, attempt: 1, result: "passed" }] as const;
    /** The step Fix or Review asks about a plan approval, with what the log kept of its change. */
    const approval = (shape: Shape, stepId: StepId, extra: Record<string, unknown>) =>
      toItemRecord(append(created(shape), [...START, { type: "decision_opened", decisionId: DECISION, kind: "plan_approval", stepId, choices: BOTH, detail: "The step finished.", ...extra }] as never))!;
    const labels = (record: ReturnType<typeof approval>) => record.decision!.choices.map((choice) => choice.label);

    it("a plan approval of a step that changed no files asks about the next step, and is no change approval", () => {
      const record = approval({ names: ["Plan", "Build"] }, FIX, { tree: TREE, change: { files: 0 } });
      expect(record.decision).toMatchObject({ kind: "plan_approval", question: "Build it this way?", why: "The step finished." });
      expect(record.decision!.hasDiff).toBeUndefined();
      expect(labels(record)).toEqual(["Approve and start Build", "Change the plan…", "End: no action needed", "Stop"]);
      expect(record.cardLine).toBe("Build it this way?");
      expect(parseItemRecord(record).ok).toBe(true);
    });

    it("a next step whose name is no command is asked as Go on to <name> this way", () => {
      expect(approval({ names: ["Plan", "Pull request"] }, FIX, { tree: TREE, change: { files: 0 } }).decision!.question).toBe("Go on to Pull request this way?");
      expect(approval({}, FIX, { tree: TREE, change: { files: 0 } }).decision!.question).toBe("Go on to Review this way?");
    });

    it("a plan approval that changed files, with a step after it, asks to go on with the change and shows the diff", () => {
      const record = approval({}, FIX, { tree: TREE, change: { files: 3 } });
      expect(record.decision).toMatchObject({ question: "Go on to Review with this change?", hasDiff: true });
      expect(labels(record)).toEqual(["Approve and start Review", "Request changes…", "End: no action needed", "Stop"]);
    });

    it("the last step with files asks to commit when the template commits, else to accept and finish", () => {
      const commit = approval({}, REVIEW, { tree: TREE, change: { files: 2 } });
      expect(commit.decision).toMatchObject({ question: "Commit this change?", hasDiff: true });
      expect(labels(commit)).toEqual(["Approve and commit", "Request changes…", "End: no action needed", "Stop"]);
      const plain = approval({ finish: ["findings"] }, REVIEW, { tree: TREE, change: { files: 2 } });
      expect(plain.decision!.question).toBe("Accept this result and finish?");
      expect(labels(plain)[0]).toBe("Approve and finish");
    });

    it("the last step with no files asks to accept and finish, with no diff and nothing to commit", () => {
      const record = approval({}, REVIEW, { tree: TREE, change: { files: 0 } });
      expect(record.decision).toMatchObject({ question: "Accept this result and finish?" });
      expect(record.decision!.hasDiff).toBeUndefined();
      expect(labels(record)).toEqual(["Approve and finish", "Change the plan…", "End: no action needed", "Stop"]);
    });

    it("a log from before the count was kept shows the diff of its tree, with the same words as a change", () => {
      const record = approval({}, FIX, { tree: TREE });
      expect(record.decision).toMatchObject({ question: "Go on to Review with this change?", hasDiff: true });
      expect(labels(record)[1]).toBe("Request changes…");
      // No tree either: no diff, and the question still names the step.
      expect(approval({}, FIX, {}).decision!.hasDiff).toBeUndefined();
    });

    it("a label that would not fit keeps the stored one", () => {
      const record = approval({ names: ["Plan", "B".repeat(60)] }, FIX, { tree: TREE, change: { files: 0 } });
      expect(labels(record)[0]).toBe("Approve");
      expect(record.decision!.question).toBe(`Go on to ${"B".repeat(60)} this way?`);
    });

    it("a failed step asks to run it again, and at its limit says how many runs it used", () => {
      const failed = toItemRecord(
        append(created(), [...START, { type: "decision_opened", decisionId: DECISION, kind: "after_failure", stepId: FIX, choices: [{ id: "retry_step", label: "Retry step" }, { id: "stop", label: "Stop" }], detail: "Step Fix failed." }]),
      )!;
      expect(failed.decision).toMatchObject({ question: "Fix failed. Run Fix again?", choices: [{ label: "Run Fix again" }, { label: "Stop" }] });
      const limit = toItemRecord(
        append(created(), [...START, { type: "decision_opened", decisionId: DECISION, kind: "after_failure", stepId: FIX, choices: [{ id: "one_more_attempt", label: "Retry once more" }, { id: "stop", label: "Stop" }], detail: "Step Fix reached its limit of 3 attempts." }]),
      )!;
      expect(limit.decision!.question).toBe("Fix used its 3 runs. Run it once more?");
      expect(limit.cardLine).toBe("Fix used its 3 runs. Run it once more?");
      const rounds = toItemRecord(
        append(created(), [...START, { type: "decision_opened", decisionId: DECISION, kind: "after_failure", stepId: FIX, choices: [{ id: "one_more_round", label: "Run one more round" }, { id: "stop", label: "Stop" }], detail: "Fix sent the work back 3 times." }]),
      )!;
      expect(rounds.decision!.question).toBe("Fix sent the work back too often. Run one more round?");
    });

    it("a run that could not start asks to run the step again", () => {
      const item = append(created(), [{ type: "step_started", stepId: FIX }, { type: "decision_opened", decisionId: DECISION, kind: "run_failure", stepId: FIX, choices: [{ id: "retry_step", label: "Retry step" }, { id: "stop", label: "Stop" }], detail: "The agent call timed out." }]);
      expect(toItemRecord(item)!.decision).toMatchObject({ question: "Fix could not run. Run Fix again?", choices: [{ label: "Run Fix again" }, { label: "Stop" }] });
    });

    it("the time budget asks to continue for the same time, and falls back when the template has none", () => {
      const open = (shape: Shape) => toItemRecord(append(created(shape), [{ type: "step_started", stepId: FIX }, { type: "decision_opened", decisionId: DECISION, kind: "budget", stepId: FIX, choices: [{ id: "continue", label: "Continue" }, { id: "stop", label: "Stop" }], detail: "The item used its time budget." }]))!;
      expect(open({ budget: 60 }).decision!.question).toBe("The item used its 60 min budget. Continue for 60 more min?");
      expect(open({}).decision!.question).toBe("The item used its time budget. Continue?");
    });

    it("keeps the words of a tamper, a cloud summary and a change outside the worktree", () => {
      const ask = (kind: string) => toItemRecord(append(created(), [{ type: "step_started", stepId: FIX }, { type: "decision_opened", decisionId: DECISION, kind, stepId: FIX, choices: [{ id: "approve", label: "Approve" }, { id: "stop", label: "Stop" }], detail: "Why." } as never]))!.decision!.question;
      expect(ask("tamper")).toBe("Files that steer Tokama changed. Approve them?");
      expect(ask("cloud_summary")).toBe("Send this summary to the cloud agent?");
      expect(ask("outside_change")).toBe("Allow this change outside the worktree?");
    });

    it("no kind asks \"Approve this step's result?\"", () => {
      const all = [approval({}, FIX, { tree: TREE, change: { files: 0 } }), approval({}, FIX, { tree: TREE }), approval({}, FIX, {}), approval({}, REVIEW, { tree: TREE, change: { files: 1 } })];
      for (const record of all) expect(record.decision!.question).not.toContain("Approve this step");
    });
  });

  it("serves nothing for a deleted item", () => {
    expect(toItemRecord(append(created(), [{ type: "tombstone" }]))).toBeUndefined();
  });

  it("keeps step ids as names and says data may leave when the snapshot no longer reads", () => {
    const item = created();
    const record = toItemRecord({ ...item, template: { ...item.template, record: { schemaVersion: 99 } } })!;
    expect(record).toMatchObject({ privacy: "local_and_cloud", steps: [{ name: "fix", data: "repo-and-diff" }, { name: "review" }] });
  });
});
