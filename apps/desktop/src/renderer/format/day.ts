// Local calendar days for the work list: the day key the engine groups by (`YYYY-MM-DD`, as core's
// localDate writes it) and the day header's label. Days are built from the calendar, never by
// adding 24 hours, so a day with a DST change is still one day.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** The local day of a time: `2026-11-24`. */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local day `days` calendar days before the day of `now`. */
export function daysBefore(now: number, days: number): string {
  const date = new Date(now);
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - days).getTime());
}

/** A day header: "Today", "Yesterday", then "Sun 22 Nov". */
export function dayLabel(day: string, now: number): string {
  if (day === localDay(now)) return "Today";
  if (day === daysBefore(now, 1)) return "Yesterday";
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const at = new Date(year, month - 1, date);
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`;
}
