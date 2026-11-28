// Times and days as every screen writes them, in local time: the clock (`09:05`), a short date
// (`23 Oct`, `Thu 23 Oct`), and the local calendar day the work list groups by (`YYYY-MM-DD`, as
// core's localDate writes it) with its header label. Days are built from the calendar, never by
// adding 24 hours, so a day with a DST change is still one day.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** The time of day on a 24-hour clock: `09:05`. */
export function clock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The time of day with seconds: `09:05:07`. */
export function clockSeconds(at: number): string {
  return `${clock(at)}:${pad(new Date(at).getSeconds())}`;
}

/** The short weekday: `Thu`. */
export const weekday = (at: number): string => WEEKDAYS[new Date(at).getDay()]!;

/** The month by name: `Oct` for 10. */
export const monthName = (month: number): string => MONTHS[month - 1] ?? "";

/** A date without the year: `23 Oct`. */
export function shortDate(at: number): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** A date with its weekday: `Thu 23 Oct`. */
export const weekdayDate = (at: number): string => `${weekday(at)} ${shortDate(at)}`;

/** Whether two times fall on the same local day. */
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** The local day of a time: `2026-11-24`. */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight at the start of the day `days` calendar days before the day of `now`. */
export function dayStart(now: number, days = 0): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - days).getTime();
}

/** The local day `days` calendar days before the day of `now`. */
export const daysBefore = (now: number, days: number): string => localDay(dayStart(now, days));

/** A day header: "Today", "Yesterday", then "Sun 22 Nov". */
export function dayLabel(day: string, now: number): string {
  if (day === localDay(now)) return "Today";
  if (day === daysBefore(now, 1)) return "Yesterday";
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return weekdayDate(new Date(year, month - 1, date).getTime());
}

/** A time as a clock today, with its date on another day: `17:10`, `Thu 23 Oct 09:00`. */
export const stamp = (at: number, now: number): string => (sameDay(at, now) ? clock(at) : `${weekdayDate(at)} ${clock(at)}`);
