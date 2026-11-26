import { BOARD_COUNT_DAYS, parseItemRecord, parseQueryResult, type ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import {
  AI_CLIS,
  attemptOf,
  badgesOf,
  boardColumns,
  bucketOf,
  cliIssuesOf,
  healthProblemsOf,
  DEFAULT_FILTER,
  filterCounts,
  finishedIn,
  listEntries,
  sinceOf,
  flagOf,
  cardStatus,
  groupItems,
  inRange,
  inView,
  needsYouCount,
  pipelineOf,
  rowAgent,
  rowMark,
  summaryOf,
  timeOf,
  viewKey,
} from "./model.js";
import { daysBefore } from "./format/time.js";
import { board } from "./testing/bridge.js";
import { ITEMS, items, NOW, setup } from "./testing/sample.js";
import { allReport, usageReport } from "./testing/usage.js";

const titles = (list: readonly ItemRecord[]) => list.map((item) => item.title);
const template = (id: string) => setup.templates.find((candidate) => candidate.id === id)!;

describe("test data", () => {
  it("matches the engine API schemas", () => {
    expect(parseQueryResult("setup", setup).ok).toBe(true);
    for (const item of items) expect(parseItemRecord(item)).toMatchObject({ ok: true });
    expect(parseQueryResult("usage", usageReport)).toMatchObject({ ok: true });
    expect(parseQueryResult("usage", allReport)).toMatchObject({ ok: true });
  });
});

describe("views", () => {
  it("keys each view apart", () => {
    expect([{ kind: "all" }, { kind: "workflow", id: "builtin/quick-fix" }, { kind: "repo", id: "quick-fix" }].map((view) => viewKey(view as never))).toEqual(["all", "workflow:builtin/quick-fix", "repo:quick-fix"]);
  });

  it("scopes items by workflow or by repo", () => {
    expect(titles(items.filter((item) => inView(item, { kind: "workflow", id: "builtin/emergency-investigator" })))).toEqual(["Checkout p95 latency spike", "Orders API returns 500 after deploy"]);
    expect(titles(items.filter((item) => inView(item, { kind: "repo", id: "inventory-service" })))).toEqual(["Stock sync drops <b>items</b>"]);
    expect(items.every((item) => inView(item, { kind: "all" }))).toBe(true);
  });
});

describe("bucketOf", () => {
  it.each([
    ["queued", "active"],
    ["running", "active"],
    ["needs_you", "needs"],
    ["done", "done"],
    ["stopped", "done"],
    ["failed", "failed"],
  ] as const)("puts a %s item in %s", (state, bucket) => {
    expect(bucketOf({ state })).toBe(bucket);
  });
});

describe("inRange", () => {
  it("counts local calendar days: today starts at midnight, 7 and 30 days go back whole days", () => {
    const at = (daysAgo: number, hour: number) => ({ createdAt: new Date(2025, 9, 20 - daysAgo, hour).getTime() });
    expect([inRange(at(0, 0), "today", NOW), inRange(at(1, 23), "today", NOW)]).toEqual([true, false]);
    // "7 days" is today and the 6 days before it; "30 days" is today and the 29 before it.
    expect([inRange(at(6, 0), "7d", NOW), inRange(at(7, 23), "7d", NOW)]).toEqual([true, false]);
    expect([inRange(at(29, 0), "30d", NOW), inRange(at(30, 23), "30d", NOW)]).toEqual([true, false]);
  });
});

/** The board's answer over the items: the open ones and the counts of the finished ones. */
const open = board(items).items;
const counts = board(items).counts;
const badgesOver = (list: readonly ItemRecord[]) => badgesOf(board(list).items, board(list).counts, NOW);

describe("finishedIn", () => {
  it("adds up the done and failed counts of the days in the range; older days count for all time only", () => {
    const rows = [
      { day: "2025-10-20", templateId: "builtin/quick-fix", repoIds: [], done: 2, failed: 1 },
      { day: "2025-10-14", templateId: "builtin/quick-fix", repoIds: [], done: 1, failed: 0 },
      { day: "2025-10-13", templateId: "builtin/quick-fix", repoIds: [], done: 5, failed: 0 },
      { day: null, templateId: "builtin/quick-fix", repoIds: [], done: 10, failed: 3 },
    ] as unknown as Parameters<typeof finishedIn>[0];
    expect(finishedIn(rows, "today", NOW)).toEqual({ done: 2, failed: 1 });
    expect(finishedIn(rows, "7d", NOW)).toEqual({ done: 3, failed: 1 });
    expect(finishedIn(rows, "30d", NOW)).toEqual({ done: 8, failed: 1 });
    expect(finishedIn(rows, "all", NOW)).toEqual({ done: 18, failed: 4 });
    expect(finishedIn([], "all", NOW)).toEqual({ done: 0, failed: 0 });
  });

  it("keeps every finite range inside the days the board counts one by one", () => {
    const firstCounted = daysBefore(NOW, BOARD_COUNT_DAYS - 1);
    for (const range of ["today", "7d", "30d"] as const) expect(sinceOf(range, NOW)! >= firstCounted).toBe(true);
  });
});

describe("filterCounts", () => {
  it("counts each status for today by default: live items always, finished ones within the range", () => {
    expect(filterCounts(open, counts, DEFAULT_FILTER, NOW)).toEqual({ active: 5, needs: 1, done: 2, failed: 1 });
  });

  it("counts Done and Failed within the view's range whichever filter is selected, so each number matches the list it opens", () => {
    expect(filterCounts(open, counts, { status: "done", range: "7d" }, NOW)).toEqual({ active: 5, needs: 1, done: 3, failed: 1 });
    expect(filterCounts(open, counts, { status: "failed", range: "30d" }, NOW)).toEqual({ active: 5, needs: 1, done: 3, failed: 2 });
    expect(filterCounts(open, counts, { status: "needs", range: "30d" }, NOW)).toEqual({ active: 5, needs: 1, done: 3, failed: 2 });
    expect(filterCounts(open, counts, { status: "active", range: "7d" }, NOW).done).toBe(3);
  });
});

describe("groupItems", () => {
  const groups = (status: Parameters<typeof groupItems>[1]["status"], range: Parameters<typeof groupItems>[1]["range"] = "today") =>
    groupItems(items, { status, range }, NOW).map((group) => [group.name, titles(group.items)]);

  it("shows Needs you and Running for Active, running items before queued ones", () => {
    expect(groups("active")).toEqual([
      ["Needs you", ["Orders API returns 500 after deploy"]],
      ["Running", ["Checkout p95 latency spike", "Fix rounding in invoice totals", "Stock sync drops <b>items</b>", "Add retry with backoff"]],
    ]);
  });

  it("shows one group per other filter, named by the range, newest first, with stopped items under Done", () => {
    expect(groups("needs")).toEqual([["Needs you", ["Orders API returns 500 after deploy"]]]);
    expect(groups("done")).toEqual([["Done today", ["Try a cache for prices", "Bump the Postgres driver"]]]);
    expect(groups("done", "7d")).toEqual([["Done last 7 days", ["Try a cache for prices", "Bump the Postgres driver", "Remove the old export flag"]]]);
    expect(groups("failed", "30d")).toEqual([["Failed last 30 days", ["Flaky checkout test", "Upgrade the build image"]]]);
  });

  it("shows every group for All, finished ones for today", () => {
    expect(groups("all").map(([name]) => name)).toEqual(["Needs you", "Running", "Done today", "Failed today"]);
  });

  it("keeps empty groups, so the list can say so", () => {
    expect(groupItems([], DEFAULT_FILTER, NOW).map((group) => group.items.length)).toEqual([0, 0]);
  });
});

describe("badgesOf", () => {
  it("counts needs you, failed today and running, in that order; queued items count nowhere", () => {
    expect(badgesOver(items).map(({ symbol, count, word }) => `${symbol} ${count} ${word}`)).toEqual(["⏸ 1 needs you", "✕ 1 failed", "● 3 running"]);
  });

  it("leaves out zero counts", () => {
    expect(badgesOver([ITEMS.queued, ITEMS.done])).toEqual([]);
    expect(badgesOver([ITEMS.failedLastMonth])).toEqual([]);
    expect(badgesOver([ITEMS.working]).map((badge) => badge.kind)).toEqual(["running"]);
  });

  it("says need for several", () => {
    expect(badgesOver([ITEMS.needsYou, { ...ITEMS.working, state: "needs_you" } as ItemRecord])[0]).toMatchObject({ count: 2, word: "need you" });
  });
});

describe("summaryOf", () => {
  it("counts live items and items done today", () => {
    expect(summaryOf(open, counts, NOW)).toBe("5 live · 2 done today");
    expect(summaryOf([], [], NOW)).toBe("0 live · 0 done today");
  });
});

describe("rowMark", () => {
  it("reads an item in a checking step as checking, as its pipeline does", () => {
    expect(rowMark(ITEMS.verifying)).toEqual({ symbol: "◐", word: "checking", tone: "live" });
    expect(pipelineOf(ITEMS.verifying)[1]?.mark).toEqual(rowMark(ITEMS.verifying));
  });

  it("keeps the item's own mark otherwise", () => {
    expect(rowMark(ITEMS.working)).toMatchObject({ symbol: "●", word: "running" });
    expect(rowMark(ITEMS.needsYou)).toMatchObject({ symbol: "⏸" });
    expect(rowMark(ITEMS.queued)).toMatchObject({ symbol: "◌" });
    expect(rowMark(ITEMS.done)).toMatchObject({ symbol: "✓" });
  });
});

describe("needsYouCount", () => {
  it("counts the items that need you", () => {
    expect(needsYouCount(items)).toBe(1);
    expect(needsYouCount([])).toBe(0);
  });
});

describe("attemptOf", () => {
  const attempt = (n: number, result?: "passed" | "failed") => ({ attempt: n, ...(result !== undefined && { result }), checks: [] });

  it("is the attempt in progress", () => {
    expect(attemptOf({ state: "running", attempts: [attempt(1, "failed"), attempt(2)] })).toBe(2);
  });

  it("is the last attempt for a step that waits for you or has failed", () => {
    expect(attemptOf({ state: "needs_you", attempts: [attempt(1, "passed")] })).toBe(1);
    expect(attemptOf({ state: "failed", attempts: [attempt(1, "failed"), attempt(2, "failed")] })).toBe(2);
  });

  it("is the next attempt when a running step's last attempt has ended", () => {
    expect(attemptOf({ state: "running", attempts: [attempt(1, "failed")] })).toBe(2);
  });

  it("is the first attempt for a step that has started and recorded none", () => {
    expect(attemptOf({ state: "running" })).toBe(1);
    expect(attemptOf({ state: "needs_you", attempts: [] })).toBe(1);
  });

  it("is none for a step that has not started", () => {
    expect(attemptOf({ state: "pending" })).toBeUndefined();
  });
});

describe("pipelineOf", () => {
  it("carries the attempt of each step", () => {
    expect(pipelineOf(ITEMS.working).map((step) => step.attempt)).toEqual([1, 1, undefined]);
    expect(pipelineOf(ITEMS.queued).map((step) => step.attempt)).toEqual([undefined, undefined, undefined, undefined]);
  });

  const symbols = (item: ItemRecord) => pipelineOf(item).map((step) => step.mark.symbol);

  it("gives every step state its symbol and a word", () => {
    expect(pipelineOf(ITEMS.needsYou).map((step) => `${step.mark.symbol} ${step.mark.word}`)).toEqual(["✓ passed", "✓ passed", "⏸ needs you"]);
    expect(pipelineOf(ITEMS.working).map((step) => `${step.mark.symbol} ${step.mark.word}`)).toEqual(["✓ passed", "● running", "○ pending"]);
    expect(symbols(ITEMS.failed)).toEqual(["✕", "○"]);
    expect(symbols(ITEMS.stopped)).toEqual(["■", "○"]);
    expect(symbols(ITEMS.queued)).toEqual(["○", "○", "○", "○"]);
  });

  it("shows a running step of the verifying stage as checking", () => {
    expect(pipelineOf(ITEMS.verifying).map((step) => `${step.mark.symbol} ${step.mark.word}`)).toEqual(["✓ passed", "◐ checking"]);
  });

  it("marks only the step the item is in as current, and none once all passed", () => {
    expect(pipelineOf(ITEMS.working).map((step) => step.current)).toEqual([false, true, false]);
    expect(pipelineOf(ITEMS.queued).map((step) => step.current)).toEqual([true, false, false, false]);
    expect(pipelineOf(ITEMS.done).some((step) => step.current)).toBe(false);
  });
});

describe("rowAgent", () => {
  const agents = setup.agents;

  it("names the agent of the step the item is in, with its dot by join order", () => {
    expect(rowAgent(ITEMS.needsYou, agents)).toMatchObject({ name: "Architect", dot: 1 });
    expect(rowAgent(ITEMS.working, agents)).toMatchObject({ name: "Local builder", dot: 2 });
  });

  it("names Tokama for a step Tokama runs itself, and the last step's agent once all passed", () => {
    expect(rowAgent(ITEMS.verifying, agents)).toMatchObject({ name: "Tokama", dot: "neutral" });
    expect(rowAgent(ITEMS.done, agents)).toMatchObject({ name: "Tokama" });
  });

  it("is undefined without steps", () => {
    expect(rowAgent({ steps: [] }, agents)).toBeUndefined();
  });
});

describe("timeOf", () => {
  const started = (minutesAgo: number, state: ItemRecord["state"] = "running") => timeOf({ state, createdAt: NOW - minutesAgo * 60_000 }, NOW);

  it("shows how long a live item has run", () => {
    expect(started(0).text).toBe("0 s");
    expect(started(14).text).toBe("14 m 00 s");
    expect(started(60).text).toBe("1 h 00 m");
    expect(started(95).text).toBe("1 h 35 m");
  });

  it("ticks to the second while running, in the drawer's format, and by the minute while it waits", () => {
    const item = { state: "running" as const, createdAt: NOW - 45_000 };
    expect(timeOf(item, NOW).text).toBe("45 s");
    expect(timeOf(item, NOW + 252_000).text).toBe("4 m 57 s");
    expect(timeOf({ ...item, state: "needs_you" }, NOW).text).toBe("0 m");
    expect(started(5, "needs_you").text).toBe("5 m");
  });

  it("shows a finished item's start as a clock time today and a date earlier", () => {
    expect(timeOf(ITEMS.done, NOW)).toEqual({ text: "13:00", title: "started 13:00" });
    expect(timeOf(ITEMS.doneLastWeek, NOW)).toEqual({ text: "17 Oct", title: "started 17 Oct 15:00" });
  });

  it("adds an ended item's agent and check time next to its clock time", () => {
    expect(timeOf({ ...ITEMS.done, durationMs: 732_000 }, NOW)).toEqual({ text: "13:00 · 12 m", title: "started 13:00 · 12 m of agent and check time" });
  });
});

describe("cardStatus", () => {
  it("gives a working card its word: working, or checking while Tokama runs the checks", () => {
    expect(cardStatus(ITEMS.working, NOW)).toEqual({ live: true, word: "working" });
    expect(cardStatus(ITEMS.verifying, NOW)).toEqual({ live: true, word: "checking" });
  });

  it("keeps the flag of an item that waits, and adds the time and total of an ended one", () => {
    expect(cardStatus(ITEMS.needsYou, NOW)).toMatchObject({ live: false, mark: { symbol: "⏸" } });
    expect(cardStatus({ ...ITEMS.done, durationMs: 732_000 }, NOW)).toEqual({ live: false, mark: { symbol: "✓", word: "done", tone: "pass" }, text: "done · 13:00 · 12 m" });
    expect(cardStatus(ITEMS.failed, NOW)).toMatchObject({ live: false, text: expect.stringMatching(/^failed at Fix · /) });
  });

  it("has no status line for a queued item", () => {
    expect(cardStatus(ITEMS.queued, NOW)).toBeUndefined();
  });
});

describe("boardColumns", () => {
  const columns = (templateId: string, list: readonly ItemRecord[]) =>
    boardColumns(list, template(templateId)).map((column): [string, string[]] => [column.name, titles(column.items)]);

  it("has Queued, one column per step and Done", () => {
    expect(columns("builtin/plan-and-build", []).map(([name]) => name)).toEqual(["Queued", "Plan", "Build", "Run checks", "Review", "Done"]);
  });

  it("puts each item in its column", () => {
    expect(columns("builtin/emergency-investigator", [ITEMS.working, ITEMS.needsYou])).toEqual([
      ["Queued", []],
      ["Triage", []],
      ["Query logs", ["Checkout p95 latency spike"]],
      ["Propose a fix", ["Orders API returns 500 after deploy"]],
      ["Done", []],
    ]);
    expect(columns("builtin/plan-and-build", [ITEMS.queued])[0]).toEqual(["Queued", ["Add retry with backoff"]]);
    expect(columns("builtin/quick-fix", [ITEMS.verifying, ITEMS.done, ITEMS.failed, ITEMS.stopped]).map(([, list]) => list)).toEqual([[], [], ["Fix rounding in invoice totals"], ["Bump the Postgres driver", "Flaky checkout test", "Try a cache for prices"]]);
  });

  it("keeps an item with more steps than its template in the last step column", () => {
    const long = { ...ITEMS.working, steps: [...ITEMS.working.steps, ...ITEMS.working.steps].map((step, index) => ({ ...step, state: index < 5 ? "passed" : "running" })) } as ItemRecord;
    expect(columns("builtin/emergency-investigator", [long]).map(([, list]) => list.length)).toEqual([0, 0, 0, 1, 0]);
  });
});

describe("flagOf", () => {
  it("asks the decision's question for a needs-you item", () => {
    expect(flagOf(ITEMS.needsYou)).toMatchObject({ mark: { symbol: "⏸", tone: "warn" }, text: "Send the redacted findings summary to Architect on Claude Code?" });
  });

  it("says where a failed item failed, and that a stopped one was stopped", () => {
    expect(flagOf(ITEMS.failed)).toMatchObject({ mark: { symbol: "✕", tone: "fail" }, text: "failed at Fix" });
    expect(flagOf(ITEMS.stopped)).toMatchObject({ mark: { symbol: "■" }, text: "stopped" });
  });

  it("has no flag for a running item", () => {
    expect(flagOf(ITEMS.working)).toBeUndefined();
  });
});

describe("AI_CLIS", () => {
  it("names every AI CLI the API knows", () => {
    expect(AI_CLIS.map((cli) => [cli.id, cli.name])).toEqual([
      ["claude-code", "Claude Code"],
      ["codex-cli", "Codex CLI"],
      ["ollama", "Ollama"],
    ]);
  });
});

describe("health from the setup", () => {
  const health = {
    git: { ok: false, message: "git 2.44 or newer is required; found: git version 2.39.0" },
    clis: [
      { cliId: "claude-code", installed: true, loggedIn: false },
      { cliId: "codex-cli", installed: false, loggedIn: false },
      { cliId: "ollama", installed: false, loggedIn: false },
    ],
    config: [{ file: "repos.yaml", message: "repos.yaml line 3: base_branch is missing" }],
  } as const;
  const slow = {
    git: { ok: true },
    clis: [{ cliId: "claude-code", installed: true, loggedIn: false, timedOut: true, message: "Claude Code didn't answer in time." }],
    config: [],
  } as const;

  it("turns logged-out and missing CLIs into rail issues; Ollama has no login", () => {
    expect(cliIssuesOf(health as never)).toEqual([
      { cliId: "claude-code", kind: "logged_out" },
      { cliId: "codex-cli", kind: "not_installed" },
    ]);
    expect(cliIssuesOf(undefined)).toEqual([]);
  });

  it("shows a CLI that did not answer as a problem, not as logged out", () => {
    expect(cliIssuesOf(slow as never)).toEqual([]);
    expect(healthProblemsOf(slow as never)).toEqual([{ title: "Claude Code didn't answer", detail: "Claude Code didn't answer in time." }]);
  });

  it("adds the PATH problem only when the login shell could not be read, first and without a setup too", () => {
    const problem = "Your login shell (zsh) did not answer within 5 s.";
    const listed = healthProblemsOf(slow as never, { source: "inherited", shell: "zsh", problem });
    expect(listed[0]).toEqual({
      title: "Your shell's PATH was not read",
      detail: `${problem} Tokama uses the PATH it was started with, so tools in Homebrew or ~/.local/bin may not be found.`,
    });
    expect(listed).toHaveLength(2);
    expect(healthProblemsOf(undefined, { source: "inherited", problem })).toHaveLength(1);
    expect(healthProblemsOf(slow as never, { source: "login-shell", shell: "zsh" })).toHaveLength(1);
    expect(healthProblemsOf(slow as never, { source: "inherited" })).toHaveLength(1);
  });

  it("adds a slow-shell problem when the login shell answered only after the timeout", () => {
    const listed = healthProblemsOf(slow as never, { source: "login-shell", shell: "zsh", slow: true });
    expect(listed[0]).toEqual({ title: "Your shell is slow to start", detail: "Reading your shell setup took over 5 seconds; Tokama starts slower. Check your ~/.zshrc for slow commands." });
    expect(listed).toHaveLength(2);
  });

  it("lists git and config problems in the engine's words", () => {
    expect(healthProblemsOf(health as never)).toEqual([
      { title: "git cannot be used", detail: "git 2.44 or newer is required; found: git version 2.39.0" },
      { title: "repos.yaml did not load", detail: "repos.yaml line 3: base_branch is missing" },
    ]);
  });
});

describe("long list days", () => {
  const now = new Date(2026, 10, 24, 0, 10).getTime();
  const at = (day: number, hour: number) => ({ id: `${day}-${hour}`, createdAt: new Date(2026, 10, day, hour).getTime() }) as unknown as ItemRecord;

  it("gives a range's first local day, and none for all time", () => {
    expect([sinceOf("today", now), sinceOf("7d", now), sinceOf("30d", now), sinceOf("all", now)]).toEqual(["2026-11-24", "2026-11-18", "2026-10-26", undefined]);
  });

  it("puts a header before each day's first row, splitting at local midnight", () => {
    const rows = [at(24, 0), at(23, 23), at(23, 1), at(20, 9)];
    const entries = listEntries(rows, new Map([["2026-11-23", 9]]), now);
    expect(entries.map((entry) => (entry.kind === "day" ? `${entry.label} ${entry.count}` : entry.item.id))).toEqual(["Today 1", "24-0", "Yesterday 9", "23-23", "23-1", "Fri 20 Nov 1", "20-9"]);
    // Without days, no headers.
    expect(listEntries(rows, undefined, now).every((entry) => entry.kind === "item")).toBe(true);
  });
});
