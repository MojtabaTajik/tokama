import { describe, expect, it } from "vitest";
import type { AttemptRecord, ChangeSummary, StoredDecision, StoredItem, StoredStep, TemplateRecord } from "../../kernel/schemas/index.js";
import { itemRisk } from "./item-risk.js";

const TREE = "a".repeat(40);
const OTHER = "b".repeat(40);
const CHANGE: ChangeSummary = { files: 3, added: 40, removed: 8 };

type Def = { id: string; doneWhen: string; agentId: string; maxAttempts: number };
const template = (...defs: Def[]) => ({ steps: defs }) as unknown as TemplateRecord;
const BUILD: Def = { id: "build", doneWhen: "checks pass", agentId: "builder", maxAttempts: 3 };
const REVIEW: Def = { id: "review", doneWhen: "reviewer approves", agentId: "reviewer", maxAttempts: 1 };

const attempt = (n: number, end: Partial<AttemptRecord>): AttemptRecord => ({ attempt: n, startedAt: n * 10, endedAt: n * 10 + 5, processes: [], checks: [], ...end });
const passedCheck = [{ command: "pnpm test", exitCode: 0, passed: true, at: 1 }];
const step = (id: string, attempts: AttemptRecord[], state: StoredStep["state"] = "passed"): StoredStep => ({ id: id as StoredStep["id"], state, attempts });
const built = (tree = TREE) => step("build", [attempt(1, { result: "passed", tree, checks: passedCheck })]);
const reviewed = (result: "passed" | "failed", tree = TREE) => step("review", [attempt(1, { result, tree })]);

function done(steps: StoredStep[], outcome: Partial<NonNullable<StoredItem["outcome"]>> = {}, decisions: StoredDecision[] = []): StoredItem {
  return { steps, decisions, state: "done", outcome: { kind: "done", at: 1, commits: [{ repoId: "orders-api", commit: "c".repeat(40) }], change: CHANGE, tree: TREE, ...outcome } } as unknown as StoredItem;
}

describe("itemRisk: a done item with a commit", () => {
  it("is low when checks passed on the committed tree and another agent approved it", () => {
    expect(itemRisk(done([built(), reviewed("passed")]), template(BUILD, REVIEW))).toEqual({ change: CHANGE, risk: { level: "low", reasons: ["small_checked_reviewed"] } });
  });

  it("is high with no_checks when the tree changed after the checks, or the template has none", () => {
    expect(itemRisk(done([built(OTHER), reviewed("passed")]), template(BUILD, REVIEW)).risk).toEqual({ level: "high", reasons: ["no_checks"] });
    expect(itemRisk(done([step("build", [attempt(1, { result: "passed", tree: TREE })]), reviewed("passed")]), template({ ...BUILD, doneWhen: "agent finishes" }, REVIEW)).risk?.reasons).toContain("no_checks");
  });

  it("is high when the last review asked for changes", () => {
    expect(itemRisk(done([built(), reviewed("failed")]), template(BUILD, REVIEW)).risk).toEqual({ level: "high", reasons: ["review_asked_changes"] });
  });

  it("does not count the review of another tree, or one by an agent that wrote the work", () => {
    const sensitive = { ...CHANGE, touches: [{ kind: "ci" as const, files: 1 }] };
    expect(itemRisk(done([built(), reviewed("passed", OTHER)], { change: sensitive }), template(BUILD, REVIEW)).risk?.reasons).toEqual(["no_review_sensitive"]);
    expect(itemRisk(done([built(), reviewed("passed")], { change: sensitive }), template(BUILD, { ...REVIEW, agentId: "builder" })).risk?.reasons).toEqual(["no_review_sensitive"]);
  });

  it("is high when the checks passed only on the last attempt the step allowed and no second agent reviewed", () => {
    const failed = attempt(1, { result: "failed", checks: [{ command: "pnpm test", exitCode: 1, passed: false, at: 1 }] });
    const lastRun = step("build", [failed, attempt(2, { result: "failed" }), attempt(3, { result: "passed", tree: TREE, checks: passedCheck })]);
    expect(itemRisk(done([lastRun]), template(BUILD)).risk).toEqual({ level: "high", reasons: ["no_review_last_attempt"] });
    // Passing earlier than the limit is not "last attempt".
    const early = step("build", [failed, attempt(2, { result: "passed", tree: TREE, checks: passedCheck })]);
    expect(itemRisk(done([early]), template(BUILD)).risk?.level).toBe("low");
  });

  it("is high after you approved a change to a protected file", () => {
    const approved = { id: "d1", kind: "tamper", askedAt: 1, choices: [], resolved: { choice: "approve", at: 2 } } as unknown as StoredDecision;
    const stopped = { ...approved, id: "d2", resolved: { choice: "stop", at: 3 } } as unknown as StoredDecision;
    expect(itemRisk(done([built(), reviewed("passed")], {}, [approved]), template(BUILD, REVIEW)).risk?.reasons).toEqual(["protected_change"]);
    expect(itemRisk(done([built(), reviewed("passed")], {}, [stopped]), template(BUILD, REVIEW)).risk?.level).toBe("low");
  });

  it("is not rated, with no change, for an item from before changes were recorded", () => {
    expect(itemRisk(done([built(), reviewed("passed")], { change: undefined, tree: undefined }), template(BUILD, REVIEW))).toEqual({ risk: { level: "not_rated", reasons: ["unreadable_change"] } });
  });

  it("is not rated for binary files only", () => {
    const binary: ChangeSummary = { files: 212, unreadable: "binary_only" };
    expect(itemRisk(done([built(), reviewed("passed")], { change: binary }), template(BUILD, REVIEW))).toEqual({ change: binary, risk: { level: "not_rated", reasons: ["unreadable_change"] } });
  });

  it("does not need the template: without one nothing is a second agent's review", () => {
    expect(itemRisk(done([built()]), undefined).risk).toEqual({ level: "low", reasons: ["small_checked"] });
  });
});

describe("itemRisk: no risk", () => {
  it("has none for an item that committed nothing, and only its change when it recorded one", () => {
    expect(itemRisk(done([built()], { commits: undefined, change: { files: 0 } }), template(BUILD))).toEqual({ change: { files: 0 } });
    expect(itemRisk(done([built()], { commits: undefined, change: undefined }), template(BUILD))).toEqual({});
  });

  it("has none for a failed, stopped or ended-early item", () => {
    for (const kind of ["failed", "stopped", "no_action_needed"] as const) expect(itemRisk(done([built()], { kind }), template(BUILD))).toEqual({});
  });

  it("has none for an item still running", () => {
    expect(itemRisk({ steps: [], decisions: [], state: "running" } as unknown as StoredItem, undefined)).toEqual({});
  });
});

describe("itemRisk: a change waiting for approval", () => {
  const waiting = (change: ChangeSummary | undefined, kind: StoredDecision["kind"] = "plan_approval"): StoredItem =>
    ({ steps: [built()], decisions: [{ id: "d1", kind, askedAt: 1, choices: [], tree: TREE, ...(change !== undefined && { change }) }], state: "needs_you" }) as unknown as StoredItem;

  it("rates the tree it would commit", () => {
    expect(itemRisk(waiting(CHANGE), template(BUILD))).toEqual({ change: CHANGE, risk: { level: "low", reasons: ["small_checked"] } });
    expect(itemRisk(waiting({ ...CHANGE, touches: [{ kind: "migrations", files: 1 }] }), template(BUILD)).risk?.reasons).toEqual(["no_review_sensitive"]);
  });

  it("is not rated when the question was logged with a file count only", () => {
    expect(itemRisk(waiting({ files: 4 }), template(BUILD)).risk).toEqual({ level: "not_rated", reasons: ["unreadable_change"] });
  });

  it("has none for a plan that changed no file, a question about something else, or a log without a change", () => {
    expect(itemRisk(waiting({ files: 0 }), template(BUILD))).toEqual({});
    expect(itemRisk(waiting(CHANGE, "tamper"), template(BUILD))).toEqual({});
    expect(itemRisk(waiting(undefined), template(BUILD))).toEqual({});
  });
});
