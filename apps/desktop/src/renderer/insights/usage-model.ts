// What the Insights page and the rail tooltip derive from the usage report: words for windows and
// times, alerts per AI CLI, number formats, and the chart's columns. Pure functions that take the
// clock as an argument, so they are tested without React or a real time.
import type { CliPlan, LogScan, Setup, TemplateSummary, TokenUsage, UsageReport } from "@tokama/core";
import type { CliIssue } from "../model.js";

/** A window at or above this share of its limit is high, then near it. */
export const HIGH = 60;
export const NEAR_LIMIT = 80;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Data older than this says how old it is. */
const SHOW_AGE_AFTER_MS = 10 * MINUTE;

type PlanWindow = CliPlan["windows"][number];

/** Each AI CLI's neutral monogram: a text label, never another company's logo. */
export const CLI_MONOGRAMS: Readonly<Record<CliPlan["cliId"], string>> = { "claude-code": "CC", "codex-cli": "CX", ollama: "OL" };

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour window",
  seven_day: "Weekly window",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  session: "Session window",
  weekly_all: "Weekly window",
};
/** "5-hour window", "Session window", "Fable weekly window"; a scoped limit without a name is "Scoped weekly window". */
export function windowLabel(w: Pick<PlanWindow, "window" | "scope">): string {
  if (w.window === "weekly_scoped") return `${w.scope ?? "Scoped"} weekly window`;
  return WINDOW_LABELS[w.window] ?? w.window.replace(/_/g, " ");
}
/** The short form, for the tooltip: "5-hour", "Weekly", "Fable weekly". */
export const windowShort = (w: Pick<PlanWindow, "window" | "scope">): string => windowLabel(w).replace(/ window$/, "");
/** "50% share of the weekly limit" for a scoped limit with a known share. */
export const shareText = (w: Pick<PlanWindow, "sharePercent">): string | undefined => (w.sharePercent === undefined ? undefined : `${Math.round(w.sharePercent)}% share of the weekly limit`);
export type Tone = "warn" | "fail";

/**
 * How full a window is: under 60% ok, 60 to 79% high, 80% or more near its limit, 100% at it.
 * Each level above ok has a word or symbol shown beside its colour.
 */
export type Level = "ok" | "high" | "near" | "limit";
export const levelOf = (usedPercent: number): Level => (usedPercent >= 100 ? "limit" : usedPercent >= NEAR_LIMIT ? "near" : usedPercent >= HIGH ? "high" : "ok");
/** The meter fill's colour token per level. */
export const LEVEL_TONE: Readonly<Record<Level, "pass" | Tone>> = { ok: "pass", high: "warn", near: "fail", limit: "fail" };
/** The word beside the percentage; ok needs none. */
export const LEVEL_WORD: Readonly<Record<Level, string | undefined>> = { ok: undefined, high: "high", near: "! near limit", limit: "✕ at limit" };
/** The level for a screen reader, after the percentage. */
export const LEVEL_SPOKEN: Readonly<Record<Level, string>> = { ok: "ok", high: "high", near: "near limit", limit: "at limit" };

export type CliAlert = "logged_out" | "not_installed" | "limit" | "near_limit";

/**
 * The windows that still say something about now: one whose reset time has passed is dropped,
 * because the report may be older than the reset (it reloads only on events while nobody looks).
 */
export const liveWindows = (plan: CliPlan | undefined, now: number): CliPlan["windows"] => (plan?.windows ?? []).filter((w) => w.resetsAt === undefined || w.resetsAt > now);

/** What the rail badge and the tooltip say about a CLI: a login problem first, then its windows. */
export function cliAlert(plan: CliPlan | undefined, issue: CliIssue | undefined, now: number): CliAlert | undefined {
  if (issue !== undefined) return issue.kind;
  // By the shown (rounded) number, so the badge agrees with the meter.
  const levels = liveWindows(plan, now).map((w) => levelOf(Math.round(w.usedPercent)));
  return levels.includes("limit") ? "limit" : levels.includes("near") ? "near_limit" : undefined;
}

export const ALERT_TEXT: Readonly<Record<CliAlert, string>> = {
  logged_out: "✕ logged out",
  not_installed: "✕ not found",
  limit: "✕ at limit",
  near_limit: "! near limit",
};
export const alertTone = (alert: CliAlert): Tone => (alert === "near_limit" ? "warn" : "fail");

/** The badge on the Insights icon: ✕ when any CLI is logged out, missing or at its limit, else ! when one is near it. */
export function railBadge(alerts: readonly (CliAlert | undefined)[]): { readonly symbol: "✕" | "!"; readonly tone: Tone } | undefined {
  if (alerts.some((alert) => alert !== undefined && alertTone(alert) === "fail")) return { symbol: "✕", tone: "fail" };
  if (alerts.includes("near_limit")) return { symbol: "!", tone: "warn" };
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "17:10" today, else "Thu 23 Oct 09:00". */
export function formatClock(at: number, now: number): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay(d, new Date(now)) ? time : `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

/** "29 min", "2 h 38 min", "3 days". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  if (ms >= 2 * DAY) return `${Math.floor(ms / DAY)} days`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** "resets 17:10 · in 2 h 38 min", or just the time when it is days away. */
export function resetText(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "reset time unknown";
  const left = resetsAt - now;
  return left < DAY ? `resets ${formatClock(resetsAt, now)} · in ${formatDuration(left)}` : `resets ${formatClock(resetsAt, now)}`;
}

/** "data 34 min old" once the data is older than a few minutes. */
export const ageText = (asOf: number, now: number): string | undefined => (now - asOf > SHOW_AGE_AFTER_MS ? `data ${formatDuration(now - asOf)} old` : undefined);

/** Every token of a call or item, cached ones included. */
export const totalOf = (tokens: TokenUsage): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

const TOKEN_UNITS = [
  ["k", 1e3],
  ["M", 1e6],
  ["B", 1e9],
] as const;
// Decimals by size: "9.9k" and "163k"; "2.41M", "38.6M" and "420M"; the same for B.
const tokenDecimals = (value: number, unit: string): number => (value >= 100 ? 0 : value >= 10 ? (unit === "k" ? 0 : 1) : unit === "k" ? 1 : 2);

/** "1.2k", "163k", "2.41M", "2.34B". The unit is chosen after rounding, so 999,950 is "1.00M", never "1000k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  for (const [index, [unit, size]] of TOKEN_UNITS.entries()) {
    const value = n / size;
    const rounded = Number(value.toFixed(tokenDecimals(value, unit)));
    if (rounded < 1000 || index === TOKEN_UNITS.length - 1) return `${rounded.toFixed(tokenDecimals(rounded, unit))}${unit}`;
  }
  return String(n);
}

/** "≈ $3.10"; unknown when nothing could be priced. */
export const formatCost = (usd: number | null): string => (usd === null ? "unknown" : `≈ $${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString("en-US")}`);

/** "$3.10", "$1,755": a table cell under a "≈ Cost" header; unknown when nothing could be priced. */
export const formatUsd = (usd: number | null): string => (usd === null ? "unknown" : formatCost(usd).slice(2));

const CARD_LABELS: Readonly<Record<string, string>> = {
  five_hour: "Session · 5 hours",
  session: "Session · 5 hours",
  seven_day: "Weekly",
  weekly_all: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};
/** A limit's name on its account card: "Session · 5 hours", "Weekly · all models", "Weekly · Fable". */
export function cardLabel(w: Pick<PlanWindow, "window" | "scope">): string {
  if (w.window === "weekly_scoped") return `Weekly · ${w.scope ?? "scoped"}`;
  return CARD_LABELS[w.window] ?? windowLabel(w);
}

/** Time to a reset, short: "38m", "2h 41m", "1d 18h". */
export function countdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
}

/** When a reset happens: "at 17:10" today, "Thu 09:00" this week, else the full date. */
export function resetWhen(resetsAt: number, now: number): string {
  const d = new Date(resetsAt);
  if (sameDay(d, new Date(now))) return `at ${formatClock(resetsAt, now)}`;
  if (resetsAt - now < 6 * DAY) return `${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return formatClock(resetsAt, now);
}

export const SOURCE_TEXT: Readonly<Record<NonNullable<CliPlan["source"]>, string>> = {
  request: "asked of the CLI itself",
  run: "from the last run's rate-limit event",
  cache: "the CLI's cached copy of its last answer",
};

/** The template of a usage key: matched like items are, by the id the record carries. */
export const templateFor = (templateId: string, setup: Setup | undefined): TemplateSummary | undefined => setup?.templates.find((t) => t.id === templateId);
export const workflowName = (templateId: string, setup: Setup | undefined): string => templateFor(templateId, setup)?.name ?? templateId.split("/").pop() ?? templateId;

export type Metric = "tokens" | "cost";

/**
 * Tokama's own calls over the range, whatever the report's scope: its totals in the `tokama`
 * scope, else the sum of its workflows (which leaves out how many calls had no price).
 */
export function tokamaTotals(report: UsageReport): { readonly tokens: number; readonly costUsd: number | null; readonly unpricedCalls: number } {
  if ((report.scope ?? "tokama") === "tokama") return { tokens: totalOf(report.totals.tokens), costUsd: report.totals.costUsd, unpricedCalls: report.totals.unpricedCalls };
  const priced = report.workflows.filter((w) => w.costUsd !== null);
  return {
    tokens: report.workflows.reduce((sum, w) => sum + w.tokens, 0),
    costUsd: priced.length === 0 ? null : priced.reduce((sum, w) => sum + (w.costUsd ?? 0), 0),
    unpricedCalls: 0,
  };
}

/** Where reading Claude Code's logs is: progress while the first read runs, the reason when it cannot, else nothing. */
export function scanText(scan: LogScan | undefined): string | undefined {
  // Later scans add a few files in moments; only the first one, with nothing read yet, shows progress.
  if (scan === undefined || scan.state === "ready" || (scan.state === "scanning" && scan.asOf !== undefined)) return undefined;
  if (scan.state === "scanning") return `Reading Claude Code logs… ${scan.filesDone} of ${scan.filesTotal} files`;
  return scan.note ?? "Claude Code's logs could not be read.";
}

export interface Segment {
  readonly templateId: string;
  readonly value: number;
}

export interface Column {
  readonly date: string;
  /** "Tue", "24": the axis label under the column. */
  readonly weekday: string;
  readonly day: string;
  /** Bottom to top, in series order. */
  readonly segments: readonly Segment[];
  readonly total: number;
}

export interface ChartModel {
  /** Workflows with usage in the range, in the setup's order (colour follows the workflow, never its rank), unknown ones last. */
  readonly series: readonly string[];
  readonly columns: readonly Column[];
  /** The top of the axis: a round number at or above the tallest column. */
  readonly max: number;
  readonly ticks: readonly number[];
}

/** A round axis top: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

export function chartModel(report: UsageReport, metric: Metric, setup: Setup | undefined): ChartModel {
  const used = new Set(report.workflows.map((w) => w.templateId));
  const order: string[] = (setup?.templates ?? []).map((t) => t.id).filter((id) => used.has(id));
  const series = [...order, ...[...used].filter((id) => !order.includes(id)).sort()];
  const columns = report.days.map((day): Column => {
    const d = new Date(`${day.date}T12:00:00`);
    const segments = series.flatMap((templateId): Segment[] => {
      const group = day.workflows.find((w) => w.templateId === templateId);
      const value = group === undefined ? 0 : metric === "tokens" ? group.tokens : (group.costUsd ?? 0);
      return value > 0 ? [{ templateId, value }] : [];
    });
    return { date: day.date, weekday: WEEKDAYS[d.getDay()]!, day: String(d.getDate()), segments, total: segments.reduce((sum, s) => sum + s.value, 0) };
  });
  const max = niceMax(Math.max(0, ...columns.map((c) => c.total)));
  return { series, columns, max, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => f * max) };
}

/** An axis label: "200k" tokens, "$4" cost. */
export const tickLabel = (value: number, metric: Metric): string =>
  metric === "cost" ? `$${value < 10 && value % 1 !== 0 ? value.toFixed(2) : Math.round(value)}` : value === 0 ? "0" : formatTokens(value);

/** Share of the day as a whole percent, at least 1 when above zero. */
export const share = (part: number, whole: number): number => (whole <= 0 || part <= 0 ? 0 : Math.max(1, Math.round((part / whole) * 100)));
