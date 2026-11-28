// What the shell derives from engine records: views, status filters, groups, badges, pipelines
// and board columns. Pure functions that take the clock as an argument, so they are tested
// without React or a real time.
import type { AgentSummary, AiCliId, BoardCount, Health, ItemRecord, StepRecord, TemplateSummary } from "@tokama/core";
import type { ToolsPathInfo } from "../shared/bridge.js";
import { BACKEND_IDS, backendOf } from "./brand/backends/index.js";
import { itemMark, stepAgent, type StepAgent, stepMark } from "./drawer/describe.js";
import { itemTotal, runningAttempt } from "./drawer/progress-view.js";
import { formatDuration } from "./format/duration.js";
import { clock, dayLabel, daysBefore, localDay, sameDay, shortDate } from "./format/time.js";
import type { StatusCount } from "./ui/Badge.js";
import { type Mark, markOf } from "./ui/status.js";

/** What the main area shows: everything, one workflow's items, or one repo's items. */
export type View = { readonly kind: "all" } | { readonly kind: "workflow"; readonly id: string } | { readonly kind: "repo"; readonly id: string };

export const ALL_WORK: View = { kind: "all" };

/** The key a view's filter choice is remembered under. */
export const viewKey = (view: View): string => (view.kind === "all" ? "all" : `${view.kind}:${view.id}`);

export const sameView = (a: View, b: View): boolean => viewKey(a) === viewKey(b);

/** Takes an item or a count row of the board: both name their template and repos. */
export const inView = (item: Pick<ItemRecord, "templateId" | "repoIds">, view: View): boolean =>
  view.kind === "all" || (view.kind === "workflow" ? item.templateId === view.id : (item.repoIds as readonly string[]).includes(view.id));

/** Where an item counts for the status filter and the groups. A stopped item counts as done. */
export type Bucket = "needs" | "active" | "done" | "failed";

export function bucketOf(item: Pick<ItemRecord, "state">): Bucket {
  switch (item.state) {
    case "needs_you":
      return "needs";
    case "failed":
      return "failed";
    case "done":
    case "stopped":
      return "done";
    default:
      return "active";
  }
}

export type StatusFilter = "active" | "needs" | "done" | "failed" | "all";
export const STATUS_FILTERS: readonly { readonly id: StatusFilter; readonly label: string }[] = [
  { id: "active", label: "Active" },
  { id: "needs", label: "Needs you" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
  { id: "all", label: "All" },
];

export type Range = "today" | "7d" | "30d" | "all";
export const RANGES: readonly { readonly id: Range; readonly label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];
/** Whole days before today that a range reaches back: "7 days" is today and the 6 days before it. */
const RANGE_DAYS: Readonly<Record<Range, number>> = { today: 0, "7d": 6, "30d": 29, all: Infinity };

export interface Filter {
  readonly status: StatusFilter;
  readonly range: Range;
}
export const DEFAULT_FILTER: Filter = { status: "active", range: "today" };

/** Whether the status's list shows finished groups, which the range limits: Done, Failed and All. */
export const listsFinished = (status: StatusFilter): boolean => status === "done" || status === "failed" || status === "all";

/** The range that applies to the list: Done, Failed and All limit finished work by it, the other filters list none. */
export const effectiveRange = (filter: Filter): Range => (listsFinished(filter.status) ? filter.range : "today");

/** The first local day of a range, as the engine filters by; undefined for all time. */
export const sinceOf = (range: Range, now: number): string | undefined => (range === "all" ? undefined : daysBefore(now, RANGE_DAYS[range]));

/** Whether the item was created within the range (local calendar days; the engine records no end time). */
export function inRange(item: Pick<ItemRecord, "createdAt">, range: Range, now: number): boolean {
  if (range === "all") return true;
  const today = new Date(now);
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - RANGE_DAYS[range]);
  return item.createdAt >= from.getTime();
}

/** Whether an item waits for you, runs or waits to run: the board holds these in full. */
export const isOpen = (item: Pick<ItemRecord, "state">): boolean => bucketOf(item) === "active" || bucketOf(item) === "needs";

/** The done and failed items of the board's counts that started within the range. */
export function finishedIn(counts: readonly BoardCount[], range: Range, now: number): { readonly done: number; readonly failed: number } {
  const since = sinceOf(range, now);
  let done = 0;
  let failed = 0;
  for (const row of counts) {
    if (since !== undefined && (row.day === null || row.day < since)) continue;
    done += row.done;
    failed += row.failed;
  }
  return { done, failed };
}

/**
 * How many finished runs the range hides on a tab: Done counts done runs, Failed failed ones, and
 * the other tabs both.
 */
export function hiddenByRange(counts: readonly BoardCount[], status: StatusFilter, range: Range, now: number): number {
  if (range === "all") return 0;
  const all = finishedIn(counts, "all", now);
  const within = finishedIn(counts, range, now);
  const done = all.done - within.done;
  const failed = all.failed - within.failed;
  return status === "done" ? done : status === "failed" ? failed : done + failed;
}

/**
 * The change that shows every finished run. On Active and Needs you, which list none, it also
 * moves to All; on the other tabs it only widens the range.
 */
export const showAllTime = (status: StatusFilter): Partial<Filter> => (listsFinished(status) ? { range: "all" } : { status: "all", range: "all" });

/** Whether an item shows under a status filter. Live items always show; finished ones only within the range. */
export function matches(item: Pick<ItemRecord, "state" | "createdAt">, status: StatusFilter, range: Range, now: number): boolean {
  const bucket = bucketOf(item);
  switch (status) {
    case "active":
      return bucket === "active" || bucket === "needs";
    case "needs":
      return bucket === "needs";
    case "done":
      return bucket === "done" && inRange(item, range, now);
    case "failed":
      return bucket === "failed" && inRange(item, range, now);
    case "all":
      return bucket === "active" || bucket === "needs" || inRange(item, range, now);
  }
}

/** The counts on the status switch: how many items each filter opens, Done and Failed within the view's range. */
export function filterCounts(items: readonly ItemRecord[], counts: readonly BoardCount[], filter: Filter, now: number): Record<Exclude<StatusFilter, "all">, number> {
  const count = (status: StatusFilter) => items.filter((item) => matches(item, status, "today", now)).length;
  const finished = finishedIn(counts, filter.range, now);
  return { active: count("active"), needs: count("needs"), done: finished.done, failed: finished.failed };
}

/** The header's summary of a view: "5 live · 2 done today". */
export function summaryOf(items: readonly ItemRecord[], counts: readonly BoardCount[], now: number): string {
  const live = items.filter(isOpen).length;
  return `${live} live · ${finishedIn(counts, "today", now).done} done today`;
}

export const visibleItems = (items: readonly ItemRecord[], filter: Filter, now: number): ItemRecord[] =>
  items.filter((item) => matches(item, filter.status, effectiveRange(filter), now));

export type GroupKey = "needs" | "running" | "done" | "failed";
export interface ItemGroup {
  readonly key: GroupKey;
  readonly name: string;
  readonly items: readonly ItemRecord[];
  /** Every item of the group, also those not loaded; the loaded items by default; undefined while loading. */
  readonly count?: number | undefined;
  /** Set when the rows go under day headers: each local day's full count. */
  readonly days?: ReadonlyMap<string, number> | undefined;
}

export type ListEntry = { readonly kind: "day"; readonly day: string; readonly label: string; readonly count: number } | { readonly kind: "item"; readonly item: ItemRecord };

/**
 * The rows of a group in their order, with a day header before the first row of each local start
 * day: "Today", "Yesterday", "Sun 22 Nov". A day split over two pages keeps one header; its count
 * is the full count the engine gave, or the loaded rows when it gave none.
 */
export function listEntries(items: readonly ItemRecord[], days: ReadonlyMap<string, number> | undefined, now: number): ListEntry[] {
  if (days === undefined) return items.map((item) => ({ kind: "item", item }));
  const entries: ListEntry[] = [];
  let last: string | undefined;
  for (const item of items) {
    const day = localDay(item.createdAt);
    if (day !== last) {
      last = day;
      entries.push({ kind: "day", day, label: dayLabel(day, now), count: days.get(day) ?? items.filter((other) => localDay(other.createdAt) === day).length });
    }
    entries.push({ kind: "item", item });
  }
  return entries;
}

const RANGE_WORDS: Readonly<Record<Range, string>> = { today: "today", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };

/** The range in the words of a group name: "Done last 30 days". */
export const rangeWords = (range: Range): string => RANGE_WORDS[range];
/** Which groups each filter shows. */
export const GROUPS_OF: Readonly<Record<StatusFilter, readonly GroupKey[]>> = {
  active: ["needs", "running"],
  needs: ["needs"],
  done: ["done"],
  failed: ["failed"],
  all: ["needs", "running", "done", "failed"],
};

/**
 * The list's groups for a filter: Needs you, Running (running items, then queued ones), Done and
 * Failed (newest first). The items are those already scoped to the view.
 */
export function groupItems(items: readonly ItemRecord[], filter: Filter, now: number): ItemGroup[] {
  const shown = visibleItems(items, filter, now);
  const words = RANGE_WORDS[effectiveRange(filter)];
  const newestFirst = (a: ItemRecord, b: ItemRecord) => b.createdAt - a.createdAt;
  const by: Record<GroupKey, { name: string; items: ItemRecord[] }> = {
    needs: { name: "Needs you", items: shown.filter((item) => bucketOf(item) === "needs") },
    running: {
      name: "Running",
      items: [...shown.filter((item) => item.state === "running"), ...shown.filter((item) => item.state === "queued")],
    },
    done: { name: `Done ${words}`, items: shown.filter((item) => bucketOf(item) === "done").sort(newestFirst) },
    failed: { name: `Failed ${words}`, items: shown.filter((item) => bucketOf(item) === "failed").sort(newestFirst) },
  };
  return GROUPS_OF[filter.status].map((key) => ({ key, name: by[key].name, items: by[key].items }));
}

export type Badge = StatusCount;
export type BadgeKind = StatusCount["kind"];

/**
 * The sidebar badges of a set of open items and the counts of the same scope: needs you and failed
 * today, the two a person acts on. Only counts above zero come back, in that order. Running is not
 * a badge (`runningCount` says it in words) and queued items count nowhere.
 */
export function badgesOf(items: readonly ItemRecord[], counts: readonly BoardCount[], now: number): Badge[] {
  const needs = items.filter((item) => item.state === "needs_you").length;
  const failed = finishedIn(counts, "today", now).failed;
  const badges: Badge[] = [
    { kind: "needs", symbol: markOf("needs_you").symbol, count: needs, word: needs === 1 ? "needs you" : "need you" },
    { kind: "failed", symbol: markOf("failed").symbol, count: failed, word: "failed" },
  ];
  return badges.filter((badge) => badge.count > 0);
}

/** How many of the items run now. */
export const runningCount = (items: readonly Pick<ItemRecord, "state">[]): number => items.filter((item) => item.state === "running").length;

export function needsYouCount(items: Iterable<Pick<ItemRecord, "state">>): number {
  let count = 0;
  for (const item of items) if (item.state === "needs_you") count++;
  return count;
}

/** The index of the step the item is in: the first that has not passed; undefined when all passed. */
export function currentStep(item: Pick<ItemRecord, "steps">): number | undefined {
  const index = item.steps.findIndex((step) => step.state !== "passed");
  return index === -1 ? undefined : index;
}


/**
 * The attempt a step is on: the last one the engine recorded, or the next one when the step runs
 * again after its last attempt ended; the first for a step that has started and recorded none.
 */
export function attemptOf(step: Pick<StepRecord, "state" | "attempts">): number | undefined {
  const last = step.attempts?.at(-1);
  if (last !== undefined) return last.result !== undefined && step.state === "running" ? last.attempt + 1 : last.attempt;
  return step.state === "pending" ? undefined : 1;
}

/** A step's mark: a running step in a verifying stage reads as checking. */
const markOfStep = (step: Pick<StepRecord, "state" | "stage">): Mark =>
  step.state === "running" && step.stage === "verifying" ? markOf("checking") : stepMark(step.state);

/** The row's status mark: the item's own, except that an item in a checking step reads as checking, as its pipeline does. */
export function rowMark(item: Pick<ItemRecord, "state" | "steps">): Mark {
  const step = item.steps[currentStep(item) ?? -1];
  const checking = step !== undefined && markOfStep(step).word === "checking";
  return item.state === "running" && checking ? markOfStep(step) : itemMark(item.state);
}

export interface RowLine {
  /** The step in words: "Build, step 2 of 3", or "Build, step 2 of 3, attempt 3 of 3" from the second attempt on. */
  readonly step: string;
  /** The step's name alone, for what names the working agent. */
  readonly stepName: string;
  /** When the running attempt started: the row says how long it has run after the step. */
  readonly since: number | undefined;
  /** Who works the step. */
  readonly agent: StepAgent;
}

/**
 * What line two of an open item's row says about its steps, in words: where it is ("Build, step 2 of 3"),
 * the attempt from the second one on ("attempt 3 of 3"), and the agent of the step. An item that ended has no
 * such line: its facts say where it stopped. Undefined for an ended item and for one without steps.
 */
export function rowLine(item: Pick<ItemRecord, "state" | "steps">, agents: readonly AgentSummary[]): RowLine | undefined {
  if (item.state === "done" || item.state === "failed" || item.state === "stopped") return undefined;
  const index = currentStep(item);
  const step = index === undefined ? undefined : item.steps[index];
  if (index === undefined || step === undefined) return undefined;
  const attempt = attemptOf(step);
  const again = attempt !== undefined && attempt > 1 ? `, attempt ${attempt}${step.maxAttempts === undefined ? "" : ` of ${step.maxAttempts}`}` : "";
  return {
    step: `${step.name}, step ${index + 1} of ${item.steps.length}${again}`,
    stepName: step.name,
    since: item.state === "running" ? runningAttempt(step)?.startedAt : undefined,
    agent: stepAgent(step, agents),
  };
}

/** The agent shown for an item: the one of the step it is in, or of the last step when all passed. */
export function rowAgent(item: Pick<ItemRecord, "steps">, agents: readonly AgentSummary[]): StepAgent | undefined {
  const step = item.steps[currentStep(item) ?? item.steps.length - 1];
  return step && stepAgent(step, agents);
}

export interface ItemTime {
  readonly text: string;
  readonly title: string;
}

/**
 * The row's time. An item that waits shows how long ago it started ("14 m", "1 h 35 m"); a finished one
 * shows its start as a clock time today or a date earlier, and its agent and check time after it
 * ("17:57 · 12 m"), without the time it waited for you. A running item shows how long it has run, to the second.
 */
export function timeOf(item: Pick<ItemRecord, "state" | "createdAt" | "durationMs">, now: number): ItemTime {
  const start = item.createdAt;
  const today = sameDay(start, now);
  const title = `started ${today ? clock(start) : `${shortDate(start)} ${clock(start)}`}`;
  if (bucketOf(item) === "done" || bucketOf(item) === "failed") {
    const text = today ? clock(start) : shortDate(start);
    const total = itemTotal(item);
    return total === undefined ? { text, title } : { text: `${text} · ${total}`, title: `${title} · ${total} of agent and check time` };
  }
  // A running item ticks to the second like the drawer; one that waits moves by the minute.
  return { text: formatDuration(now - start, item.state === "running" ? "exact" : "minutes"), title };
}

export interface BoardColumn {
  readonly key: string;
  readonly name: string;
  readonly items: readonly ItemRecord[];
}

/**
 * One workflow's kanban columns: Queued, one per step of its template (by position, since names
 * may repeat) and Done. A running item sits in the step it is in; finished items and items whose
 * steps all passed sit in Done. An item with more steps than the template's summary stays in the
 * last step column. The items are those already scoped to the workflow.
 */
export function boardColumns(items: readonly ItemRecord[], template: TemplateSummary): BoardColumn[] {
  const last = template.steps.length - 1;
  const columnOf = (item: ItemRecord): number => {
    if (item.state === "queued") return -1;
    const at = currentStep(item);
    if (bucketOf(item) === "done" || bucketOf(item) === "failed" || at === undefined) return template.steps.length;
    return Math.min(at, last);
  };
  const at = (column: number) => items.filter((item) => columnOf(item) === column);
  return [
    { key: "queued", name: "Queued", items: at(-1) },
    ...template.steps.map((step, index) => ({ key: `step-${index}`, name: step.name, items: at(index) })),
    { key: "done", name: "Done", items: at(template.steps.length) },
  ];
}

export type Flag = { readonly mark: Mark; readonly text: string };

/**
 * What a needs-you row or card says the item waits for: the question, or for a setup that failed
 * before the checks what ran and how it ended ("Setup failed, checks not run: pnpm install · exit 1").
 */
export function askOf(decision: ItemRecord["decision"]): string | undefined {
  const failed = decision?.setupFailed;
  if (failed?.when !== "checks") return decision?.question;
  const ended = failed.exitCode !== undefined ? `exit ${failed.exitCode}` : failed.ended === "timed_out" ? "timed out" : "could not start";
  return `Setup failed, checks not run: ${failed.command} · ${ended}`;
}

/** The card's flag line: what a needs-you item asks, where a failed item failed, or that it was stopped. */
export function flagOf(item: Pick<ItemRecord, "state" | "steps" | "decision">): Flag | undefined {
  if (item.state === "needs_you") return { mark: markOf("needs_you"), text: askOf(item.decision) ?? "needs you" };
  if (item.state === "failed") {
    const step = item.steps.find((s) => s.state === "failed");
    return { mark: markOf("failed"), text: step ? `failed at ${step.name}` : "failed" };
  }
  if (item.state === "stopped") return { mark: markOf("stopped"), text: "stopped" };
  return undefined;
}

/**
 * The card's status line: a working item's word (it gets a breathing dot), or the flag of an item
 * that waits or ended; an ended item adds its time and total ("done · 17:57 · 12 m").
 */
export type CardStatus = { readonly live: true; readonly word: "working" | "checking" } | ({ readonly live: false } & Flag);

const DONE: Mark = markOf("done");

export function cardStatus(item: Pick<ItemRecord, "state" | "steps" | "decision" | "createdAt" | "durationMs">, now: number): CardStatus | undefined {
  const running = item.steps.find((step) => step.state === "running");
  if (item.state === "running" && running !== undefined) return { live: true, word: running.stage === "verifying" ? "checking" : "working" };
  const flag = item.state === "done" ? { mark: DONE, text: "done" } : flagOf(item);
  if (flag === undefined) return undefined;
  const ended = item.state === "done" || item.state === "failed" || item.state === "stopped";
  return { live: false, mark: flag.mark, text: ended ? `${flag.text} · ${timeOf(item, now).text}` : flag.text };
}

/** The AI CLIs that sign in with a command of their own (Ollama runs locally and has none). */
export type LoginCliId = Exclude<AiCliId, "ollama">;

/** Something wrong with an AI CLI that the engineer has to fix outside Tokama. */
export interface CliIssue {
  readonly cliId: LoginCliId;
  readonly kind: "logged_out" | "not_installed";
}

/** Something else the engine found wrong: git, or a config file that did not load. */
export interface HealthProblem {
  readonly title: string;
  readonly detail: string;
}

/** The AI CLIs the engine found logged out or missing. */
export function cliIssuesOf(health: Health | undefined): CliIssue[] {
  return (health?.clis ?? []).flatMap((cli): CliIssue[] => {
    if (cli.cliId === "ollama" || cli.timedOut === true) return [];
    if (!cli.installed) return [{ cliId: cli.cliId, kind: "not_installed" as const }];
    return cli.loggedIn ? [] : [{ cliId: cli.cliId, kind: "logged_out" as const }];
  });
}

/**
 * Git and config problems, each with the engine's own words, and the app's own: the login shell's
 * PATH could not be read, which is why tools may be missing from the engine.
 */
export function healthProblemsOf(health: Health | undefined, toolsPath?: ToolsPathInfo): HealthProblem[] {
  const path: HealthProblem[] =
    toolsPath?.problem === undefined
      ? []
      : [{ title: "Your shell's PATH was not read", detail: `${toolsPath.problem} Tokama uses the PATH it was started with, so tools in Homebrew or ~/.local/bin may not be found.` }];
  if (toolsPath?.slow === true) {
    path.push({ title: "Your shell is slow to start", detail: "Reading your shell setup took over 5 seconds; Tokama starts slower. Check your shell's startup files for slow commands." });
  }
  if (health === undefined) return path;
  const git = health.git.ok ? [] : [{ title: "git cannot be used", detail: health.git.message ?? "git did not answer." }];
  // A timeout with no CLI there is the engine's checks failing as a whole: the git problem already says so.
  const slow = health.clis.filter((cli) => cli.timedOut === true && cli.installed).map((cli) => ({ title: `${cliName(cli.cliId)} didn't answer`, detail: cli.message ?? "The check did not finish in time." }));
  return [...path, ...git, ...slow, ...health.config.map((problem) => ({ title: `${problem.file} did not load`, detail: problem.message }))];
}

/** What to run in a terminal to sign in again, as each CLI's own help lists it. Tokama never runs it. */
export const LOGIN_COMMANDS: Readonly<Record<LoginCliId, string>> = {
  "claude-code": "claude auth login",
  "codex-cli": "codex login",
};

/** The AI CLIs the rail's Insights tooltip lists, with their names. */
export const AI_CLIS: readonly { readonly id: AiCliId; readonly name: string }[] = BACKEND_IDS.map((id) => ({ id, name: backendOf(id).name }));

export const cliName = (id: AiCliId): string => AI_CLIS.find((cli) => cli.id === id)?.name ?? id;
