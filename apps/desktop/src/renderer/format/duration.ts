// How long something took, has run or has left, the one format every screen uses: `45 s`,
// `4 m 12 s`, `1 h 05 m`, `2 d 03 h`. The live timer ticks in it; finished work shows it.

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A duration: `45 s`, `4 m 12 s`, `1 h 05 m`, `2 d 03 h`. `coarse` leaves the seconds out from
 * one minute on (`12 m`), for totals and waiting times next to other words. `fine` keeps a tenth
 * of a second under ten seconds (`4.2 s`), for quick commands such as checks. `minutes` is coarse
 * and also says `0 m` under a minute, for times that move on a clock slower than a second.
 */
export function formatDuration(ms: number, precision: "exact" | "coarse" | "fine" | "minutes" = "exact"): string {
  if (precision === "fine" && ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return precision === "minutes" ? "0 m" : `${seconds} s`;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${pad(hours)} h`;
  if (hours > 0) return `${hours} h ${pad(minutes)} m`;
  return precision === "coarse" || precision === "minutes" ? `${minutes} m` : `${minutes} m ${pad(seconds % 60)} s`;
}

/** How long ago, to the minute: `12 m ago`, `0 m ago`. */
export const ago = (ms: number): string => `${formatDuration(ms, "minutes")} ago`;
