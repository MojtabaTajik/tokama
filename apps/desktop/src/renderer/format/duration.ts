// How long something took or has run, the one format every screen uses: `45 s`, `4 m 12 s`,
// `1 h 05 m`. The live timer ticks in it; finished work shows it.

/**
 * A duration as the live timer shows it: `45 s`, `4 m 12 s`, `1 h 05 m`. `coarse` leaves the
 * seconds out from one minute on (`12 m`), for totals and waiting times next to other words.
 */
export function formatDuration(ms: number, precision: "exact" | "coarse" = "exact"): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours} h ${pad(minutes)} m`;
  return precision === "coarse" ? `${minutes} m` : `${minutes} m ${pad(seconds % 60)} s`;
}
