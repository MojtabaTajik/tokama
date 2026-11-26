import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  CheckTrialSchema,
  COMMAND_ERROR_CODES,
  CommandSchema,
  EventSchema,
  HelperRunSchema,
  HelperSummarySchema,
  isUnknownEvent,
  MAX_CHECK_CHARS,
  parseClientMessage,
  parseCommandResult,
  parseQueryResult,
  SuggestChecksResultSchema,
  UsageReportSchema,
} from "./index.js";

const RUN_ID = "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const TRIAL_ID = "trial_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const check = () => ({ command: "pnpm test", why: "Runs the unit tests.", minutes: 3 });
const agent = () => ({ agentId: "helper", name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" });
const run = (patch: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  helperId: "suggest-checks",
  helperVersion: 1,
  state: "running",
  phase: "asking",
  startedAt: 1000,
  agent: agent(),
  ...patch,
});
const done = () => ({ state: "done", endedAt: 2000, result: { helperId: "suggest-checks", value: { checks: [check()] } } });
const trial = (patch: Record<string, unknown> = {}) => ({ trialId: TRIAL_ID, state: "running", startedAt: 1000, checks: [{ command: "pnpm test", state: "waiting" }], ...patch });
const summary = (patch: Record<string, unknown> = {}) => ({ helperId: "suggest-checks", name: "Suggest checks", version: 1, available: true, agent: agent(), sends: ["file names"], ...patch });

/** A run record with `phase` removed, as an ended run has it. */
const ended = (patch: Record<string, unknown>) => {
  const record: Record<string, unknown> = run();
  delete record["phase"];
  return { ...record, ...patch };
};

describe("suggest-checks result", () => {
  const parse = (value: unknown) => SuggestChecksResultSchema.safeParse(value).success;

  it("takes 0 to 4 checks and an optional note", () => {
    expect(parse({ checks: [] })).toBe(true);
    expect(parse({ checks: [check(), check(), check(), check()], note: "Found a pnpm workspace." })).toBe(true);
    expect(parse({ checks: [check(), check(), check(), check(), check()] })).toBe(false);
  });

  it("refuses a command with a line break, a control character or more than 500 characters", () => {
    expect(parse({ checks: [{ ...check(), command: "pnpm test\npnpm lint" }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), command: "pnpm test\u0007" }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), command: `pnpm test${LINE_SEPARATOR}` }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), command: "x".repeat(MAX_CHECK_CHARS) }] })).toBe(true);
    expect(parse({ checks: [{ ...check(), command: "x".repeat(MAX_CHECK_CHARS + 1) }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), command: "" }] })).toBe(false);
  });

  it("limits the reason to one line of 200 characters and the minutes to 1 to 120", () => {
    expect(parse({ checks: [{ ...check(), why: "x".repeat(200) }] })).toBe(true);
    expect(parse({ checks: [{ ...check(), why: "x".repeat(201) }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), why: "one\ntwo" }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), minutes: 0 }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), minutes: 1 }] })).toBe(true);
    expect(parse({ checks: [{ ...check(), minutes: 120 }] })).toBe(true);
    expect(parse({ checks: [{ ...check(), minutes: 121 }] })).toBe(false);
    expect(parse({ checks: [{ ...check(), minutes: 1.5 }] })).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(parse({ checks: [], extra: 1 })).toBe(false);
    expect(parse({ checks: [{ ...check(), extra: 1 }] })).toBe(false);
  });
});

describe("run_helper command", () => {
  const request = (patch: Record<string, unknown> = {}) => ({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: "/work/orders-api" } }, ...patch });
  const parse = (value: unknown) => CommandSchema.safeParse(value).success;

  it("takes a helper with its input, and the cloud OK", () => {
    expect(parse(request())).toBe(true);
    expect(parse(request({ cloud: "accepted" }))).toBe(true);
  });

  it("refuses an unknown helper, a missing path, an extra field and any other cloud value", () => {
    expect(parse(request({ run: { helperId: "write-poem", input: { path: "/work/orders-api" } } }))).toBe(false);
    expect(parse(request({ run: { helperId: "suggest-checks", input: {} } }))).toBe(false);
    expect(parse(request({ run: { helperId: "suggest-checks" } }))).toBe(false);
    expect(parse(request({ run: { helperId: "suggest-checks", input: { path: "/work/orders-api", extra: 1 } } }))).toBe(false);
    expect(parse(request({ cloud: true }))).toBe(false);
    expect(parse(request({ cloud: "yes" }))).toBe(false);
    expect(parse(request({ extra: 1 }))).toBe(false);
  });
});

describe("helper run record", () => {
  const parse = (value: unknown) => HelperRunSchema.safeParse(value).success;

  it("accepts a run in each state", () => {
    expect(parse(run())).toBe(true);
    expect(parse(ended(done()))).toBe(true);
    expect(parse(ended({ state: "failed", endedAt: 2000, error: { code: "bad_answer", message: "Not valid twice." } }))).toBe(true);
    expect(parse(ended({ state: "cancelled", endedAt: 2000 }))).toBe(true);
    expect(parse(ended({ ...done(), usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 } }))).toBe(true);
  });

  it("refuses a running run without a phase, or with an end, a result or an error", () => {
    expect(parse(run({ phase: undefined }))).toBe(false);
    expect(parse(run({ endedAt: 2000 }))).toBe(false);
    expect(parse(run({ result: done().result }))).toBe(false);
    expect(parse(run({ error: { code: "crash", message: "x" } }))).toBe(false);
  });

  it("refuses a done run without a result, or with the result of another helper", () => {
    expect(parse(ended({ state: "done", endedAt: 2000 }))).toBe(false);
    expect(parse(ended({ ...done(), helperId: "other" }))).toBe(false);
  });

  it("refuses a failed run without an error, or a run with an error that did not fail", () => {
    expect(parse(ended({ state: "failed", endedAt: 2000 }))).toBe(false);
    expect(parse(ended({ ...done(), error: { code: "crash", message: "x" } }))).toBe(false);
  });

  it("refuses an ended run without an end time, or one that ended before it started", () => {
    expect(parse(ended({ state: "cancelled" }))).toBe(false);
    expect(parse(ended({ state: "cancelled", endedAt: 999 }))).toBe(false);
    expect(parse(ended({ state: "cancelled", endedAt: 1000 }))).toBe(true);
  });

  it("accepts any error code and refuses a bad id", () => {
    expect(parse(ended({ state: "failed", endedAt: 2000, error: { code: "from_a_newer_engine", message: "x" } }))).toBe(true);
    expect(parse(run({ runId: "run_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c" }))).toBe(false);
  });
});

describe("helper summary", () => {
  const parse = (value: unknown) => HelperSummarySchema.safeParse(value).success;

  it("has a problem exactly when it is not available", () => {
    expect(parse(summary())).toBe(true);
    expect(parse(summary({ available: false, problem: "Claude Code is not logged in." }))).toBe(true);
    expect(parse(summary({ problem: "Claude Code is not logged in." }))).toBe(false);
    expect(parse(summary({ available: false }))).toBe(false);
  });

  it("may have no agent when the agent file is broken", () => {
    const record: Record<string, unknown> = summary({ available: false, problem: "The helper agent file is broken." });
    delete record["agent"];
    expect(parse(record)).toBe(true);
  });
});

describe("check trial record", () => {
  const parse = (value: unknown) => CheckTrialSchema.safeParse(value).success;
  const checks = (count: number) => Array.from({ length: count }, (_, i) => ({ command: `pnpm test ${i}`, state: "waiting" }));

  it("takes 1 to 20 checks", () => {
    expect(parse(trial())).toBe(true);
    expect(parse(trial({ checks: checks(0) }))).toBe(false);
    expect(parse(trial({ checks: checks(20) }))).toBe(true);
    expect(parse(trial({ checks: checks(21) }))).toBe(false);
  });

  it("takes the last 2,000 characters of output, at most", () => {
    const withOutput = (outputTail: string) => trial({ checks: [{ command: "pnpm lint", state: "failed", exitCode: 1, durationMs: 900, outputTail }] });
    expect(parse(withOutput("x".repeat(2000)))).toBe(true);
    expect(parse(withOutput("x".repeat(2001)))).toBe(false);
  });

  it("takes a short commit and a trial error", () => {
    expect(parse(trial({ commit: "4f9c2ab" }))).toBe(true);
    expect(parse(trial({ commit: "HEAD" }))).toBe(false);
    expect(parse(trial({ state: "failed", endedAt: 2000, error: { code: "worktree_failed", message: "No worktree." } }))).toBe(true);
  });
});

describe("API messages", () => {
  const message = (fields: Record<string, unknown>) => ({ apiVersion: API_VERSION, requestId: "r1", ...fields });

  it("round-trips each new command and query", () => {
    const commands = [
      { type: "run_helper", run: { helperId: "suggest-checks", input: { path: "/work/orders-api" } }, cloud: "accepted" },
      { type: "cancel_helper", runId: RUN_ID },
      { type: "try_checks", path: "/work/orders-api", baseBranch: "main", checks: ["pnpm test", "pnpm lint"] },
      { type: "cancel_check_trial", trialId: TRIAL_ID },
    ];
    for (const command of commands) expect(parseClientMessage(message({ kind: "command", command }))).toMatchObject({ ok: true, value: { command } });
    const queries = [{ type: "helpers" }, { type: "helper_run", runId: RUN_ID }, { type: "check_trial", trialId: TRIAL_ID }];
    for (const query of queries) expect(parseClientMessage(message({ kind: "query", query }))).toMatchObject({ ok: true, value: { query } });
  });

  it("refuses try_checks with no checks, more than 20, an empty command or a long one", () => {
    const parse = (checks: unknown) => CommandSchema.safeParse({ type: "try_checks", path: "/work/orders-api", checks }).success;
    expect(parse([])).toBe(false);
    expect(parse(Array.from({ length: 21 }, () => "pnpm test"))).toBe(false);
    expect(parse([""])).toBe(false);
    expect(parse(["x".repeat(MAX_CHECK_CHARS + 1)])).toBe(false);
    expect(parse(["pnpm test"])).toBe(true);
  });

  it("parses each new reply", () => {
    expect(parseCommandResult("run_helper", { runId: RUN_ID }).ok).toBe(true);
    expect(parseCommandResult("cancel_helper", null).ok).toBe(true);
    expect(parseCommandResult("try_checks", { trialId: TRIAL_ID }).ok).toBe(true);
    expect(parseCommandResult("cancel_check_trial", null).ok).toBe(true);
    expect(parseQueryResult("helpers", { helpers: [summary()] }).ok).toBe(true);
    expect(parseQueryResult("helper_run", { run: run() }).ok).toBe(true);
    expect(parseQueryResult("check_trial", { trial: trial() }).ok).toBe(true);
    expect(parseQueryResult("helper_run", { run: run({ phase: undefined }) }).ok).toBe(false);
  });

  it("parses the new events, which an older client skips as unknown", () => {
    expect(EventSchema.safeParse({ type: "helper_run_updated", run: run() }).success).toBe(true);
    expect(EventSchema.safeParse({ type: "check_trial_updated", trial: trial() }).success).toBe(true);
    const event = (type: string) => ({ apiVersion: API_VERSION, kind: "event", seq: 1, event: { type } });
    expect(isUnknownEvent(event("helper_run_updated"))).toBe(false);
    expect(isUnknownEvent(event("check_trial_updated"))).toBe(false);
    expect(isUnknownEvent(event("from_a_newer_engine"))).toBe(true);
  });

  it("has the new command error codes", () => {
    expect(COMMAND_ERROR_CODES).toEqual(expect.arrayContaining(["helper_unavailable", "cloud_not_accepted", "busy"]));
  });
});

describe("usage report helpers block", () => {
  const report = (patch: Record<string, unknown> = {}) => ({
    range: 14,
    asOf: 1000,
    pricesAsOf: "2026-11-01",
    clis: [],
    days: [],
    workflows: [],
    items: [],
    totals: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, calls: 0, unpricedCalls: 0 },
    ...patch,
  });
  const helpers = [{ helperId: "suggest-checks", tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.04, calls: 6 }];

  it("is optional, so an older engine's report still parses", () => {
    expect(UsageReportSchema.safeParse(report()).success).toBe(true);
    expect(UsageReportSchema.safeParse(report({ helpers })).success).toBe(true);
    expect(UsageReportSchema.safeParse(report({ helpers: [{ ...helpers[0], helperId: "other" }] })).success).toBe(false);
  });
});

describe("schema index", () => {
  it("loads every schema, so an import cycle cannot leave one undefined", async () => {
    const schemas = await import("./index.js");
    expect([schemas.CommandSchema, schemas.HelperRunSchema, schemas.UsageReportSchema, schemas.CheckTrialSchema, schemas.HelperIdSchema]).not.toContain(undefined);
  });
});
