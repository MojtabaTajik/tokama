// The words of Settings > Diagnostics: each entry's type, summary, time and size, and the bottom
// bar's lines. Pure, so each state's text is tested without the page. Summaries come from the
// entry's typed fields only; the entry's text is shown as it is elsewhere.
import type { DiagnosticEntry } from "@tokama/core";
import type { DiagnosticsSendFailure } from "../../shared/bridge.js";
import { clock, dayLabel, localDay, monthName } from "../format/time.js";

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
  index_rebuilt: "The usage database was rebuilt",
  renderer_unresponsive: "The window stopped answering for a while",
  update_check_failed: "The check for an update failed",
  update_download_failed: "The download of an update failed",
  update_install_failed: "An update could not be installed",
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
/** Local midnight of the day `daysBack` calendar days before the day of `time`; a day with a clock change is not 24 hours long. */
const startOfDay = (time: number, daysBack = 0) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
};

/** One line about the entry, from its typed fields. */
export function summary(entry: DiagnosticEntry): string {
  switch (entry.type) {
    case "error":
      return `${entry.name} in the ${SOURCE_WORD[entry.source]}, ${WHERE_WORD[entry.where]}`;
    case "warning":
      return WARNING_WORD[entry.code];
    case "usage": {
      const [, month, day] = entry.day.split("-").map(Number);
      return `Daily usage summary for ${day} ${monthName(month ?? 1)}`;
    }
    case "crash":
      return `${CRASH_SUBJECT[entry.source]} ${CRASH_WORD[entry.kind]}`;
  }
}

/** "Today 14:52", "Yesterday 18:40", or "Mon 23 Nov" before that; local time. */
export function timeLabel(at: number, now: number): string {
  const day = dayLabel(localDay(at), now);
  return day === "Today" || day === "Yesterday" ? `${day} ${clock(at)}` : day;
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
      return at >= startOfDay(now, 6);
    case "30d":
      return at >= startOfDay(now, 29);
  }
}

const entries = (count: number) => (count === 1 ? "1 entry" : `${count} entries`);

export const sendLabel = (count: number) => `Send all (${count})`;
export const sendingLine = (count: number) => `Sending all ${entries(count)}…`;
export const sentLine = (count: number, kept = 0) =>
  kept === 0 ? `Sent ${entries(count)}. ${count === 1 ? "It was" : "They were"} removed from this Mac.` : `Sent ${entries(count)}. ${entries(kept)} couldn’t be removed from this Mac and may be sent again.`;

const FAILURE_REASON: Record<DiagnosticsSendFailure, string> = {
  timeout: "tokama.dev didn’t answer within 30 seconds.",
  network: "tokama.dev couldn’t be reached. Check the connection.",
  rate_limited: "tokama.dev has too many reports right now; try again in a minute.",
  busy_today: "The server is busy today; try tomorrow.",
  too_large: "They are larger than tokama.dev takes.",
  rejected: "tokama.dev didn’t accept them.",
  unsupported: "tokama.dev didn’t accept how they were packed.",
  server: "tokama.dev couldn’t store them.",
  bad_reply: "tokama.dev’s answer didn’t confirm they were stored.",
  not_connected: "The engine isn’t running.",
  no_receiver: "This development build sends to no server.",
  busy: "A send is running already.",
  nothing: "Nothing was waiting.",
};

/** `detail`: the receiver's own short reason for a refusal, shown after the plain words. */
export const failedLine = (count: number, reason: DiagnosticsSendFailure, detail?: string) =>
  `Couldn’t send ${entries(count)}. ${reason === "rejected" && detail !== undefined ? `tokama.dev didn’t accept them: ${detail.replace(/\.$/, "")}.` : FAILURE_REASON[reason]} ${count === 1 ? "It is" : "They are"} kept here.`;
