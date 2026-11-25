// The words of Settings > Diagnostics: each entry's type, summary, time and size, and the bottom
// bar's lines. Pure, so each state's text is tested without the page. Summaries come from the
// entry's typed fields only; the entry's text is shown as it is elsewhere.
import type { DiagnosticEntry } from "@tokama/core";
import type { DiagnosticsSendFailure } from "../../shared/bridge.js";

/** The type filters. A crash counts as an error: the filter has no type of its own for it. */
export type ShownType = "error" | "warning" | "usage";
export const TYPE_FILTERS = [
  { id: "all", label: "All" },
  { id: "error", label: "Error" },
  { id: "warning", label: "Warning" },
  { id: "usage", label: "Usage" },
] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number]["id"];

export const DATE_FILTERS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "all", label: "All" },
] as const;
export type DateFilter = (typeof DATE_FILTERS)[number]["id"];

export const shownType = (entry: DiagnosticEntry): ShownType => (entry.type === "crash" ? "error" : entry.type);

export const TYPE_WORD: Record<ShownType, string> = { error: "Error", warning: "Warning", usage: "Usage" };

const SOURCE_WORD = { engine: "engine", desktop: "app", renderer: "window" } as const;
const WHERE_WORD = {
  uncaught: "not caught",
  unhandled_rejection: "not caught",
  request: "while answering a request",
  startup: "at start",
  recovery: "while recovering items",
  storage: "in item storage",
  shutdown: "at shutdown",
} as const;
const WARNING_WORD = {
  item_not_loaded: "An item's log did not load",
  index_rebuilt: "The board index was rebuilt",
  renderer_unresponsive: "The window stopped answering for a while",
} as const;
const CRASH_WORD = {
  unclean_exit: "stopped unexpectedly",
  crashed: "crashed",
  oom: "ran out of memory",
  killed: "was killed",
  launch_failed: "did not start",
  integrity_failure: "failed a code integrity check",
  abnormal_exit: "stopped unexpectedly",
  memory_eviction: "was closed to free memory",
} as const;
const CRASH_SUBJECT = { engine: "Engine", desktop: "Tokama", renderer: "Window" } as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** One line about the entry, from its typed fields. */
export function summary(entry: DiagnosticEntry): string {
  switch (entry.type) {
    case "error":
      return `${entry.name} in the ${SOURCE_WORD[entry.source]}, ${WHERE_WORD[entry.where]}`;
    case "warning":
      return WARNING_WORD[entry.code];
    case "usage": {
      const [, month, day] = entry.day.split("-").map(Number);
      return `Daily usage summary for ${day} ${MONTHS[(month ?? 1) - 1]}`;
    }
    case "crash":
      return `${CRASH_SUBJECT[entry.source]} ${CRASH_WORD[entry.kind]}`;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const startOfDay = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** "Today 14:52", "Yesterday 18:40", or "Mon 23 Nov" before that; local time. */
export function timeLabel(at: number, now: number): string {
  const date = new Date(at);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = startOfDay(now);
  if (at >= today) return `Today ${clock}`;
  if (at >= startOfDay(today - DAY_MS / 2)) return `Yesterday ${clock}`;
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** The text's size: "0.6 KB", "1.1 KB". */
export function sizeLabel(text: string): string {
  const kb = new TextEncoder().encode(text).byteLength / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

/** Whether an entry recorded at `at` shows under the date filter. */
export function inDateRange(at: number, filter: DateFilter, now: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "today":
      return at >= startOfDay(now);
    case "7d":
      return at >= startOfDay(now) - 6 * DAY_MS;
    case "30d":
      return at >= startOfDay(now) - 29 * DAY_MS;
  }
}

const entries = (count: number) => (count === 1 ? "1 entry" : `${count} entries`);

export const sendLabel = (count: number) => `Send all (${count})`;
export const sendingLine = (count: number) => `Sending all ${entries(count)}…`;
export const sentLine = (count: number) => `Sent ${entries(count)}. ${count === 1 ? "It was" : "They were"} removed from this Mac.`;

const FAILURE_REASON: Record<DiagnosticsSendFailure, string> = {
  timeout: "tokama.dev didn’t answer within 30 seconds.",
  network: "tokama.dev couldn’t be reached. Check the connection.",
  rate_limited: "tokama.dev has too many reports right now, try later.",
  too_large: "They are larger than tokama.dev takes.",
  rejected: "tokama.dev didn’t accept their format.",
  unsupported: "tokama.dev didn’t accept how they were packed.",
  server: "tokama.dev couldn’t store them.",
  bad_reply: "tokama.dev’s answer didn’t confirm they were stored.",
  not_connected: "The engine isn’t running.",
  busy: "A send is running already.",
  nothing: "Nothing was waiting.",
};

export const failedLine = (count: number, reason: DiagnosticsSendFailure) => `Couldn’t send ${entries(count)}. ${FAILURE_REASON[reason]} ${count === 1 ? "It is" : "They are"} kept here.`;
