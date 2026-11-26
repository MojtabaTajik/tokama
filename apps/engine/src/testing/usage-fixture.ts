// A home folder with item logs that hold recorded calls, and the `tokama.db` of schema version 4 that
// an earlier engine kept beside them: one row per call, a plan sample and Claude Code's usage.
import { DatabaseSync } from "node:sqlite";
import { type AiCliId, ItemStore, loadHostId, localDate, manualClock, parseTemplateRecord, type RepoId, type StepId, type StoredItem } from "@tokama/core";

process.env.TZ = "Europe/Berlin";

export const USAGE_NOW = new Date(2026, 10, 26, 12).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUILD = "build" as StepId;

/** The tables of schema version 4, as the engine created them before usage was read from the logs. */
export const V4_SCHEMA = `
  CREATE TABLE usage_calls (
    call_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    template_ref TEXT NOT NULL,
    repo_id TEXT,
    ended_at INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX usage_calls_ended_at ON usage_calls (ended_at);
  CREATE TABLE plan_samples (
    cli_id TEXT PRIMARY KEY,
    as_of INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_messages (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    project TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX claude_local_messages_at ON claude_local_messages (at);
  CREATE TABLE claude_local_files (
    file_key TEXT PRIMARY KEY,
    ino INTEGER NOT NULL,
    offset INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_projects (
    project TEXT PRIMARY KEY,
    repo_id TEXT
  ) STRICT;
`;

function templateOf(ref: string, name: string) {
  const parsed = parseTemplateRecord({
    schemaVersion: 2,
    ref,
    id: ref.split("/")[1],
    source: { kind: "builtin" },
    name,
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    steps: [{ id: BUILD, name: "Build", agentId: "builder", instructions: { text: "Do it." }, doneWhen: "agent finishes", ifFailed: { action: "ask" }, maxAttempts: 1, data: "none", sees: [], connections: [], commands: [] }],
    finish: ["commit"],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.value;
}

interface Spent {
  readonly n: number;
  readonly endedAt: number;
  readonly cliId?: AiCliId;
  readonly model?: string;
  readonly planPercent?: number;
}

function usageEvent({ n, endedAt, cliId = "claude-code", model = "claude-opus-5-5", planPercent }: Spent) {
  return {
    type: "usage_recorded" as const,
    usage: {
      callId: `call_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as never,
      stepId: BUILD,
      attempt: 1,
      agentId: "builder" as never,
      cliId,
      model,
      outcome: "completed" as const,
      startedAt: endedAt - 5 * MINUTE,
      endedAt,
      tokens: { input: 100_000 * n, output: 1_000 * n, cacheRead: 10_000 * n, cacheWrite: 500 * n },
      ...(planPercent !== undefined && { plan: { status: "allowed" as const, windows: [{ window: "five_hour" as const, usedPercent: planPercent, resetsAt: endedAt + 2 * HOUR }], at: endedAt } }),
    },
  };
}

/**
 * Writes four items into `home`: one with a repo and calls from today to 100 days back, one
 * with no repo whose calls end at the same times as the first one's, one with two repos, and
 * a deleted one. Returns the items as the logs fold them.
 */
export function writeUsageItems(home: string): StoredItem[] {
  const hostId = loadHostId(home);
  if (!hostId.ok) throw new Error(hostId.error);
  const store = ItemStore.open({ home, hostId: hostId.value, clock: manualClock(USAGE_NOW) }).store;
  const quickFix = templateOf("orders-api/quick-fix", "Quick fix");
  const triage = templateOf("northwind/triage", "Triage");
  const make = (template: ReturnType<typeof templateOf>, title: string, repoIds: string[], calls: readonly Spent[]): StoredItem => {
    const created = store.create({ template, title, text: "", repoIds: repoIds as RepoId[] });
    if (!created.ok) throw new Error(created.error.message);
    const appended = store.append(created.value.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
      ...calls.map(usageEvent),
    ]);
    if (!appended.ok) throw new Error(appended.error.message);
    return created.value;
  };
  make(quickFix, "Fix the checkout timeout", ["orders-api"], [
    { n: 1, endedAt: USAGE_NOW - HOUR, planPercent: 40 },
    { n: 2, endedAt: USAGE_NOW - 3 * DAY, planPercent: 55 },
    { n: 3, endedAt: USAGE_NOW - 20 * DAY, model: "claude-sonnet-5-5" },
    { n: 4, endedAt: USAGE_NOW - 60 * DAY },
    { n: 5, endedAt: USAGE_NOW - 100 * DAY },
  ]);
  make(triage, "Triage the login errors", [], [
    { n: 7, endedAt: USAGE_NOW - 3 * DAY },
    { n: 6, endedAt: USAGE_NOW - HOUR },
    { n: 8, endedAt: USAGE_NOW - 2 * HOUR, cliId: "codex-cli", model: "gpt-5" },
    { n: 11, endedAt: USAGE_NOW - 2 * HOUR, cliId: "ollama", model: "local-model" },
  ]);
  make(quickFix, "Raise the retry limit", ["checkout-web", "orders-api"], [{ n: 10, endedAt: USAGE_NOW - 2 * DAY }]);
  const deleted = make(quickFix, "Remove the old export", ["orders-api"], [{ n: 9, endedAt: USAGE_NOW - HOUR }]);
  const ended = store.append(deleted.id, [{ type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed" }, { type: "step_ended", stepId: BUILD, result: "passed" }, { type: "item_ended", outcome: "done" }, { type: "tombstone" }]);
  if (!ended.ok) throw new Error(ended.error.message);
  return store.list();
}


/**
 * Writes `<home>/tokama.db` as an engine of schema version 4 kept it: a row for each call of the
 * items that are not deleted, a plan sample, and Claude Code's usage for two days of one project.
 */
export function writeV4Database(file: string, items: readonly StoredItem[]): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec(V4_SCHEMA);
    raw.exec("PRAGMA user_version = 4");
    const insert = raw.prepare("INSERT INTO usage_calls (call_id, item_id, title, template_ref, repo_id, ended_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const item of items) {
      if (item.deleted) continue;
      for (const call of item.calls ?? []) insert.run(call.callId, item.id, item.title, item.templateRef, item.repoIds[0] ?? null, call.endedAt, JSON.stringify(call));
    }
    raw.prepare("INSERT INTO plan_samples (cli_id, as_of, record) VALUES ('claude-code', ?, ?)").run(
      USAGE_NOW - 10 * MINUTE,
      JSON.stringify({ windows: [{ window: "five_hour", usedPercent: 36, resetsAt: USAGE_NOW + HOUR }], asOf: USAGE_NOW - 10 * MINUTE }),
    );
    const message = raw.prepare("INSERT INTO claude_local_messages (key, at, day, model, project, input, output, cache_read, cache_write) VALUES (?, ?, ?, 'claude-opus-5-5', 'p1', 10, 20, 30, 40)");
    for (const [key, at] of [["req_1", USAGE_NOW - DAY], ["req_2", USAGE_NOW - 2 * DAY]] as const) message.run(key, at, localDate(at));
    raw.prepare("INSERT INTO claude_local_files (file_key, ino, offset) VALUES ('f1', 7, 99)").run();
    raw.prepare("INSERT INTO claude_local_projects (project, repo_id) VALUES ('p1', 'orders-api')").run();
  } finally {
    raw.close();
  }
}
