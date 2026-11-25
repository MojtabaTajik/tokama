import { describe, expect, it } from "vitest";
import { StoredItemSchema, type DecisionId, type ItemEventBody, type StoredItem } from "../../kernel/schemas/index.js";
import { countedAttempts, foldItem, openAttempt, openDecisions } from "./fold.js";
import { BUILD, created, DECISION, events, HOST, ITEM, REVIEW, T0, TEMPLATE_REF } from "./testing/events.js";

const decisionId = DECISION as DecisionId;

function fold(bodies: readonly ItemEventBody[]): StoredItem {
  const folded = foldItem(events(bodies));
  if (!folded.ok) throw new Error(`fold failed at seq ${folded.error.seq}: ${folded.error.message}`);
  // The fold's output is always a valid stored record.
  expect(StoredItemSchema.safeParse(folded.value).success).toBe(true);
  return folded.value;
}

function foldError(bodies: readonly ItemEventBody[]): string {
  const folded = foldItem(events(bodies));
  if (folded.ok) throw new Error("expected the fold to fail");
  return folded.error.message;
}

const call = (n: number, attempt = 1) => ({
  callId: `call_0190a000-0000-7000-8000-00000000000${n}` as never,
  stepId: BUILD,
  attempt,
  agentId: "builder" as never,
  cliId: "claude-code" as const,
  model: "claude-opus-5-5",
  outcome: "completed" as const,
  startedAt: T0,
  endedAt: T0 + 1_000,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
});

const startBuild: ItemEventBody[] = [created(), { type: "step_started", stepId: BUILD }, { type: "attempt_started", stepId: BUILD, attempt: 1 }];

describe("foldItem", () => {
  it("item_created: a queued item with pending steps and the template snapshot", () => {
    const item = fold([created()]);
    expect(item).toMatchObject({
      schemaVersion: 1,
      id: ITEM,
      hostId: HOST,
      templateRef: TEMPLATE_REF,
      title: "Fix the checkout timeout",
      repoIds: ["orders-api"],
      worktrees: [],
      state: "queued",
      steps: [
        { id: BUILD, state: "pending", attempts: [] },
        { id: REVIEW, state: "pending", attempts: [] },
      ],
      decisions: [],
      deleted: false,
      createdAt: T0,
      updatedAt: T0,
      lastSeq: 0,
    });
    expect(item.template.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.template.record).toMatchObject({ name: "Quick fix" });
  });

  it("worktree_added: records the repo-relative worktree; several repos may have one each", () => {
    const item = fold([
      created(),
      { type: "worktree_added", repoId: "orders-api" as never, branch: "tokama/0190a000", dir: ".tokama/wt/0190a000" },
      { type: "worktree_added", repoId: "billing" as never, branch: "tokama/0190a000", dir: ".tokama/wt/0190a000" },
    ]);
    expect(item.worktrees).toEqual([
      { repoId: "orders-api", branch: "tokama/0190a000", dir: ".tokama/wt/0190a000" },
      { repoId: "billing", branch: "tokama/0190a000", dir: ".tokama/wt/0190a000" },
    ]);
    expect(
      foldError([
        created(),
        { type: "worktree_added", repoId: "orders-api" as never, branch: "a", dir: "a" },
        { type: "worktree_added", repoId: "orders-api" as never, branch: "b", dir: "b" },
      ]),
    ).toMatch(/already has a worktree/);
  });

  it("step_started and attempt_started: the item runs, the step has an open attempt", () => {
    const item = fold(startBuild);
    expect(item.state).toBe("running");
    expect(item.currentStepId).toBe(BUILD);
    expect(item.steps[0]).toMatchObject({ state: "running", attempts: [{ attempt: 1, startedAt: T0 + 2000, processes: [], checks: [] }] });
    expect(openAttempt(item)?.attempt.attempt).toBe(1);
  });

  it("process_started: records pid, start time, boot time and host on the attempt", () => {
    const item = fold([...startBuild, { type: "process_started", stepId: BUILD, attempt: 1, role: "agent", pid: 4242, bootTime: T0 - 86_400_000 }]);
    expect(item.steps[0]?.attempts[0]?.processes).toEqual([{ role: "agent", pid: 4242, startedAt: T0 + 3000, bootTime: T0 - 86_400_000, hostId: HOST }]);
    const grouped = fold([...startBuild, { type: "process_started", stepId: BUILD, attempt: 1, role: "check", pid: 77, bootTime: T0, pgid: 77 }]);
    expect(grouped.steps[0]?.attempts[0]?.processes[0]).toMatchObject({ pid: 77, pgid: 77 });
  });

  it("check_result: records each check on the attempt", () => {
    const item = fold([
      ...startBuild,
      { type: "check_result", stepId: BUILD, attempt: 1, command: "pnpm test", exitCode: 1, passed: false, outputFile: "checks/build-1.log" },
    ]);
    expect(item.steps[0]?.attempts[0]?.checks).toEqual([
      { command: "pnpm test", exitCode: 1, passed: false, outputFile: "checks/build-1.log", at: T0 + 3000 },
    ]);
  });

  it("attempt_ended: closes the attempt; run failures do not count, work failures do", () => {
    const item = fold([
      ...startBuild,
      { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "run_failed", failure: "rate_limit" },
      { type: "attempt_started", stepId: BUILD, attempt: 2 },
      { type: "attempt_ended", stepId: BUILD, attempt: 2, result: "failed" },
      { type: "attempt_started", stepId: BUILD, attempt: 3 },
    ]);
    const build = item.steps[0];
    expect(build?.attempts.map((a) => [a.attempt, a.result, a.failure])).toEqual([
      [1, "run_failed", "rate_limit"],
      [2, "failed", undefined],
      [3, undefined, undefined],
    ]);
    expect(countedAttempts(build ?? { id: BUILD, state: "pending", attempts: [] })).toBe(2);
    expect(foldError([...startBuild, { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "run_failed" }])).toMatch(/failure is given/);
    expect(foldError([...startBuild, { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "failed", failure: "crash" }])).toMatch(/failure is given/);
  });

  it("attempt_ended and item_ended: the checked tree on a passed attempt, the commits on a done item", () => {
    const tree = "a".repeat(40);
    const commit = "b".repeat(40);
    const item = fold([
      created(),
      { type: "worktree_added", repoId: "orders-api" as never, branch: "tokama/0190a000", dir: ".tokama/wt/0190a000", baseCommit: "c".repeat(40) },
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
      { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed", tree },
      { type: "step_ended", stepId: BUILD, result: "passed" },
      { type: "item_ended", outcome: "done", commits: [{ repoId: "orders-api" as never, commit }] },
    ]);
    expect(item.worktrees[0]?.baseCommit).toBe("c".repeat(40));
    expect(item.steps[0]?.attempts[0]?.tree).toBe(tree);
    expect(item.outcome?.commits).toEqual([{ repoId: "orders-api", commit }]);
    expect(foldError([...startBuild, { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "failed", tree }])).toMatch(/only on a passed attempt/);
    const asked = fold([
      created(),
      { type: "worktree_added", repoId: "orders-api" as never, branch: "tokama/0190a000", dir: ".tokama/wt/0190a000" },
      { type: "baseline_recorded", repoId: "orders-api" as never, protectedDigest: "d".repeat(64) },
      { type: "decision_opened", decisionId, kind: "tamper", choices: [{ id: "approve", label: "Approve" }], covers: [{ path: "package.json", mode: "100644", blob: tree }], tree },
    ]);
    expect(asked.worktrees[0]?.protectedDigest).toBe("d".repeat(64));
    const added = { type: "worktree_added", repoId: "orders-api" as never, branch: "tokama/0190a000", dir: ".tokama/wt/0190a000" } as const;
    const baseline = { type: "baseline_recorded", repoId: "orders-api" as never, protectedDigest: "d".repeat(64) } as const;
    expect(foldError([created(), baseline])).toMatch(/no worktree for orders-api/);
    expect(foldError([created(), added, baseline, { ...baseline, protectedDigest: "e".repeat(64) }])).toMatch(/already has a baseline/);
    expect(asked.decisions[0]).toMatchObject({ covers: [{ path: "package.json", mode: "100644", blob: tree }], tree });
    expect(foldError([created(), { type: "item_ended", outcome: "stopped", commits: [{ repoId: "orders-api" as never, commit }] }])).toMatch(/only when the item is done/);
  });

  it("step_ended: sets the step's result and leaves no current step; back to a step continues its attempt count", () => {
    const item = fold([
      ...startBuild,
      { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed" },
      { type: "step_ended", stepId: BUILD, result: "passed" },
      { type: "step_started", stepId: REVIEW },
      { type: "attempt_started", stepId: REVIEW, attempt: 1 },
      { type: "attempt_ended", stepId: REVIEW, attempt: 1, result: "failed" },
      { type: "step_ended", stepId: REVIEW, result: "failed" },
      // back: build
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 2 },
    ]);
    expect(item.currentStepId).toBe(BUILD);
    expect(item.steps.map((s) => [s.id, s.state, s.attempts.length])).toEqual([
      [BUILD, "running", 2],
      [REVIEW, "failed", 1],
    ]);
    const between = fold([...startBuild, { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed" }, { type: "step_ended", stepId: BUILD, result: "passed" }]);
    expect(between.currentStepId).toBeUndefined();
    expect(between.state).toBe("running");
  });

  it("decision_opened and decision_resolved: needs you while open, with kind and askedAt", () => {
    const asked: ItemEventBody[] = [
      ...startBuild,
      { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "run_failed", failure: "quota" },
      {
        type: "decision_opened",
        decisionId,
        kind: "run_failure",
        stepId: BUILD,
        choices: [
          { id: "retry_step", label: "Retry step" },
          { id: "stop", label: "Stop" },
        ],
      },
    ];
    const waiting = fold(asked);
    expect(waiting.state).toBe("needs_you");
    expect(waiting.steps[0]?.state).toBe("needs_you");
    expect(openDecisions(waiting)).toEqual([{ id: decisionId, kind: "run_failure", stepId: BUILD, askedAt: T0 + 4000, choices: expect.any(Array) }]);

    const resolved = fold([...asked, { type: "decision_resolved", decisionId, choice: "retry_step" }]);
    expect(resolved.state).toBe("running");
    expect(resolved.steps[0]?.state).toBe("running");
    expect(resolved.decisions[0]?.resolved).toEqual({ choice: "retry_step", at: T0 + 5000 });
    expect(openDecisions(resolved)).toEqual([]);

    expect(foldError([...asked, { type: "decision_resolved", decisionId, choice: "approve" }])).toMatch(/not a choice/);
    expect(
      foldError([...asked, { type: "decision_resolved", decisionId, choice: "stop" }, { type: "decision_resolved", decisionId, choice: "stop" }]),
    ).toMatch(/already resolved/);
    expect(foldError([...asked, asked.at(-1) as ItemEventBody])).toMatch(/exists/);
  });

  it("item_ended: each outcome maps to a final state, including ended with no action needed", () => {
    for (const [outcome, state] of [
      ["done", "done"],
      ["no_action_needed", "done"],
      ["failed", "failed"],
      ["stopped", "stopped"],
    ] as const) {
      const item = fold([created(), { type: "step_started", stepId: BUILD }, { type: "item_ended", outcome }]);
      expect(item.state).toBe(state);
      expect(item.outcome).toEqual({ kind: outcome, at: T0 + 2000 });
      expect(item.currentStepId).toBeUndefined();
      expect(item.steps[0]?.state).toBe("stopped");
    }
    expect(foldError([created(), { type: "item_ended", outcome: "done" }, { type: "step_started", stepId: BUILD }])).toMatch(/has ended/);
    expect(foldError([...startBuild, { type: "item_ended", outcome: "stopped" }])).toMatch(/attempt is still running/);
  });

  it("an ended item has no open decisions", () => {
    const item = fold([
      created(),
      { type: "decision_opened", decisionId, kind: "plan_approval", choices: [{ id: "approve", label: "Approve" }] },
      { type: "item_ended", outcome: "stopped" },
    ]);
    expect(openDecisions(item)).toEqual([]);
  });

  it("usage_recorded: adds the call to the item without changing its state or board time, even after the item ended", () => {
    const running = fold([...startBuild, { type: "usage_recorded", usage: call(1) }]);
    expect(running.calls).toEqual([call(1)]);
    expect(running.state).toBe("running");
    expect(running.updatedAt).toBe(fold(startBuild).updatedAt);

    const ended = fold([
      ...startBuild,
      { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "stopped" },
      { type: "item_ended", outcome: "stopped" },
      { type: "usage_recorded", usage: call(2) },
    ]);
    expect(ended).toMatchObject({ state: "stopped", calls: [call(2)] });
  });

  it("usage_recorded: refuses an unknown step, an attempt that never started and a call recorded twice", () => {
    expect(foldError([...startBuild, { type: "usage_recorded", usage: { ...call(1), stepId: "deploy" as never } }])).toMatch(/no step deploy/);
    expect(foldError([...startBuild, { type: "usage_recorded", usage: call(1, 2) }])).toMatch(/never started/);
    expect(foldError([...startBuild, { type: "usage_recorded", usage: call(1) }, { type: "usage_recorded", usage: call(1) }])).toMatch(/already recorded/);
  });

  it("tombstone: marks the item deleted and nothing may follow", () => {
    const item = fold([created(), { type: "item_ended", outcome: "done" }, { type: "tombstone", reason: "cleanup" }]);
    expect(item.deleted).toBe(true);
    expect(item.state).toBe("done");
    expect(foldError([created(), { type: "tombstone" }, { type: "step_started", stepId: BUILD }])).toMatch(/tombstone/);
    expect(foldError([...startBuild, { type: "tombstone" }])).toMatch(/attempt is still running/);
  });

  it("refuses logs whose order or numbering is broken", () => {
    expect(foldError([])).toMatch(/empty/);
    expect(foldError([{ type: "step_started", stepId: BUILD }])).toMatch(/start with item_created/);
    expect(foldError([created(), created()])).toMatch(/only be the first/);
    expect(foldError([created(), { type: "step_started", stepId: "deploy" as never }])).toMatch(/no step deploy/);
    expect(foldError([created(), { type: "attempt_started", stepId: BUILD, attempt: 1 }])).toMatch(/not running/);
    expect(foldError([created(), { type: "step_started", stepId: BUILD }, { type: "attempt_started", stepId: BUILD, attempt: 2 }])).toMatch(/expected attempt 1/);
    expect(foldError([...startBuild, { type: "attempt_started", stepId: BUILD, attempt: 2 }])).toMatch(/still running/);
    expect(foldError([...startBuild, { type: "step_started", stepId: REVIEW }])).toMatch(/still running/);
    // Another step while the item is still in one (no step_ended in between).
    expect(foldError([created(), { type: "step_started", stepId: BUILD }, { type: "step_started", stepId: REVIEW }])).toMatch(/still in step build/);
    // A step that waits on a decision cannot be started again before the answer.
    expect(
      foldError([
        created(),
        { type: "step_started", stepId: BUILD },
        { type: "decision_opened", decisionId, kind: "after_failure", stepId: BUILD, choices: [{ id: "retry_step", label: "Retry step" }] },
        { type: "step_started", stepId: BUILD },
      ]),
    ).toMatch(/waits on a decision/);
    expect(foldError([...startBuild, { type: "step_ended", stepId: BUILD, result: "passed" }])).toMatch(/still running/);
    expect(foldError([created(), { type: "step_started", stepId: BUILD }, { type: "step_ended", stepId: REVIEW, result: "passed" }])).toMatch(/not the current step/);
    expect(foldError([...startBuild, { type: "process_started", stepId: BUILD, attempt: 2, role: "agent", pid: 5, bootTime: 0 }])).toMatch(/not running/);
    expect(foldError([...startBuild, { type: "check_result", stepId: REVIEW, attempt: 1, command: "x", exitCode: 0, passed: true }])).toMatch(/not running/);

    const gap = events([created(), { type: "step_started", stepId: BUILD }]);
    const skipped = gap.map((event, index) => (index === 1 ? { ...event, seq: 2 } : event));
    expect(foldItem(skipped)).toEqual({ ok: false, error: { seq: 2, message: "expected seq 1, got 2" } });
    const foreign = gap.map((event, index) => (index === 1 ? { ...event, itemId: "item_0190a000-0000-7000-8000-00000000000b" as never } : event));
    expect(foldItem(foreign).ok).toBe(false);
  });

  it("is pure: folding the same events twice gives equal records, and inputs are not changed", () => {
    const log = events(startBuild);
    const copy = structuredClone(log);
    const first = foldItem(log);
    expect(foldItem(log)).toEqual(first);
    expect(log).toEqual(copy);
  });
});

describe("finish events", () => {
  const COMMIT = "a".repeat(40);
  const worktree: ItemEventBody = { type: "worktree_added", repoId: "orders-api" as never, branch: "tokama/0000000a", dir: ".tokama/wt/0000000a", baseCommit: "b".repeat(40), pushUrl: "https://github.com/acme/orders-api.git" };
  const done: ItemEventBody[] = [created(), worktree, { type: "item_ended", outcome: "done", commits: [{ repoId: "orders-api" as never, commit: COMMIT }] }];
  const start = (action: "merge" | "pull_request" | "discard"): ItemEventBody => ({ type: "finish_started", action });

  it("follow a done item: the running action, its result, and the next action clears the last failure", () => {
    expect(fold(done).worktrees[0]?.pushUrl).toBe("https://github.com/acme/orders-api.git");
    expect(fold([...done, start("merge")]).finish).toEqual({ running: "merge", worktreeRemoved: false });
    const failed = fold([...done, start("merge"), { type: "finish_failed", action: "merge", detail: "dirty" }]);
    expect(failed.finish).toMatchObject({ worktreeRemoved: false, failed: { action: "merge", detail: "dirty" } });
    expect(failed.finish?.running).toBeUndefined();
    expect(failed.state).toBe("done");
    const opened = fold([...done, start("merge"), { type: "finish_failed", action: "merge", detail: "dirty" }, start("pull_request"), { type: "pr_opened", repoId: "orders-api" as never, url: "https://github.com/acme/orders-api/pull/7" }]);
    expect(opened.finish).toMatchObject({ pullRequest: { url: "https://github.com/acme/orders-api/pull/7" }, worktreeRemoved: false });
    expect(opened.finish?.failed).toBeUndefined();
    const merged = fold([...done, start("merge"), { type: "merged", repoId: "orders-api" as never, baseBranch: "main", commit: COMMIT, worktreeRemoved: false, detail: "kept" }]);
    expect(merged.finish).toMatchObject({ merged: { baseBranch: "main", commit: COMMIT }, worktreeRemoved: false, detail: "kept" });
    expect(fold([...done, start("merge"), { type: "merged", repoId: "orders-api" as never, baseBranch: "main", commit: COMMIT, worktreeRemoved: false }, start("discard"), { type: "discarded", repoId: "orders-api" as never }]).finish?.worktreeRemoved).toBe(true);
  });

  it("git_changes_accepted: after a refusal for changed git config or hooks, sets the new baseline and clears the refusal", () => {
    const D1 = "1".repeat(64);
    const D2 = "2".repeat(64);
    const withBaseline: ItemEventBody[] = [created(), worktree, { type: "baseline_recorded", repoId: "orders-api" as never, protectedDigest: D1 }, done[2]!];
    const refused: ItemEventBody[] = [...withBaseline, start("merge"), { type: "finish_failed", action: "merge", reason: "steering_changed", detail: "changed", changes: [{ what: "setting core.autocrlf", after: "input" }], gitDigest: D2 }];
    expect(fold(refused).finish?.failed).toMatchObject({ reason: "steering_changed", changes: [{ what: "setting core.autocrlf" }], gitDigest: D2 });
    const accepted = fold([...refused, { type: "git_changes_accepted", repoId: "orders-api" as never, protectedDigest: D2 }]);
    expect(accepted.worktrees[0]?.protectedDigest).toBe(D2);
    expect(accepted.finish?.failed).toBeUndefined();
    expect(foldError([...withBaseline, { type: "git_changes_accepted", repoId: "orders-api" as never, protectedDigest: D2 }])).toMatch(/no Finish action was refused/);
    expect(foldError([...refused, start("merge"), { type: "git_changes_accepted", repoId: "orders-api" as never, protectedDigest: D2 }])).toMatch(/still running/);
  });

  it("refuse what does not fit: an item not done, a second start, a result without its start, anything after the worktree is gone", () => {
    expect(foldError([created(), worktree, start("discard")])).toMatch(/only once the item is done/);
    expect(foldError([created(), worktree, { type: "item_ended", outcome: "stopped" }, start("discard")])).toMatch(/only once the item is done/);
    expect(foldError([created(), { type: "item_ended", outcome: "done" }, start("discard")])).toMatch(/no worktree/);
    expect(foldError([created(), worktree, { type: "item_ended", outcome: "done" }, start("merge")])).toMatch(/no commit/);
    expect(foldError([...done, start("merge"), start("discard")])).toMatch(/merge is still running/);
    expect(foldError([...done, { type: "discarded", repoId: "orders-api" as never }])).toMatch(/without a running discard/);
    expect(foldError([...done, start("merge"), { type: "finish_failed", action: "discard", detail: "x" }])).toMatch(/without a running discard/);
    expect(foldError([...done, start("discard"), { type: "discarded", repoId: "orders-api" as never }, start("discard")])).toMatch(/worktree is gone/);
    expect(foldError([...done, start("pull_request"), { type: "pr_opened", repoId: "orders-api" as never, url: "https://github.com/acme/orders-api/pull/7" }, start("merge")])).toMatch(/pull request/);
    expect(foldError([...done, start("discard"), { type: "tombstone" }])).toMatch(/still running/);
    expect(foldError([...done, { type: "step_started", stepId: BUILD }])).toMatch(/has ended/);
  });
});
