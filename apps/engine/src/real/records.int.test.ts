// Stored items to API item records, on logs written by the real item store.
import { mkdtempSync, rmSync } from "node:fs";
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

function template(): TemplateRecord {
  const step = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: id === "fix" ? "Fix" : "Review",
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
    schemaVersion: 1,
    ref: "orders-api/careful-fix",
    id: "careful-fix",
    source: { kind: "repo", repoId: "orders-api", file: ".tokama/templates/careful-fix.yaml" },
    name: "Careful fix",
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    finish: ["commit"],
    steps: [step("fix", { doneWhen: "checks pass", checks: { from: "repo" }, data: "repo-and-diff" }), step("review", { doneWhen: "reviewer approves", ifChangesRequested: { action: "ask" } })],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

function created(): StoredItem {
  const made = store.create({ template: template(), title: "Fix the greeting", text: "Fix the greeting\nIt says helo.", repoIds: ["orders-api" as never] });
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
  store = ItemStore.open({ home, hostId: hostId.value, clock: manualClock(T0) }).store;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("toItemRecord", () => {
  it("maps a new item from its template snapshot: ref, kind, privacy and every step pending", () => {
    const record = toItemRecord(created())!;
    expect(record).toMatchObject({ templateId: "orders-api/careful-fix", kind: "task", privacy: "local_and_cloud", state: "queued", title: "Fix the greeting", cardLine: "starting" });
    expect(record.steps).toEqual([
      { name: "Fix", stage: "working", state: "pending", agentId: "builder", data: "repo-and-diff" },
      { name: "Review", stage: "review", state: "pending", agentId: "reviewer", data: "none" },
    ]);
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
    expect(record.decision).toMatchObject({ id: DECISION, kind: "run_failure", stepIndex: 0, question: "The run failed. Retry the step, or stop?", choices: [{ id: "retry_step" }, { id: "stop" }] });
    expect(record.decision!.why!.length).toBeLessThanOrEqual(500);
    expect(record.steps[0]).toMatchObject({ state: "needs_you", detail: "waits for you", attempts: [{ result: "run_failed", failure: "timeout" }] });
    expect(parseItemRecord(record).ok).toBe(true);
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

  it("serves nothing for a deleted item", () => {
    expect(toItemRecord(append(created(), [{ type: "tombstone" }]))).toBeUndefined();
  });

  it("keeps step ids as names and says data may leave when the snapshot no longer reads", () => {
    const item = created();
    const record = toItemRecord({ ...item, template: { ...item.template, record: { schemaVersion: 99 } } })!;
    expect(record).toMatchObject({ privacy: "local_and_cloud", steps: [{ name: "fix", data: "repo-and-diff" }, { name: "review" }] });
  });
});
