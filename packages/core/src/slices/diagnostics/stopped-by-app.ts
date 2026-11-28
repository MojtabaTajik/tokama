// The note the desktop app leaves right before it kills an engine (SIGKILL). The killed engine
// cannot remove its running marker, so without the note the next engine would record the stop as
// a crash. The note lives in the diagnostics folder, so it survives an app relaunch (an update).
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, replaceTextSync } from "../../kernel/fs-safe/index.js";

export const STOPPED_BY_APP_FILE = "engine.stopped-by-app";

/** The diagnostics folder of a Tokama home (or, for the sample engine, of its engine dir): the one place the engine and the app both name it. */
export const diagnosticsDirOf = (home: string): string => join(home, "diagnostics");

/** A clock a few minutes ahead of this one still counts: the app and the engine read the same machine clock, but it may be set back between them. */
const FUTURE_SLACK_MS = 5 * 60_000;

/**
 * How long a note counts. Long, because an update that installs on quit does not start the app
 * again until the user opens it, maybe days later. The pid match and the single use bind a note to
 * one dead engine; the limit only keeps a stray note from lasting for ever.
 */
export const STOPPED_BY_APP_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Writes the note for the engine with this pid. Returns false when it could not be written; the kill then goes ahead as a crash. */
export function markStoppedByApp(dir: string, pid: number, now: number): boolean {
  return replaceTextSync(join(dir, STOPPED_BY_APP_FILE), `${JSON.stringify({ pid, at: now })}\n`).ok;
}

/** Removes the note again, when the kill it was written for did not happen. */
export function unmarkStoppedByApp(dir: string): void {
  try {
    unlinkSync(join(dir, STOPPED_BY_APP_FILE));
  } catch {
    // Not there.
  }
}

/**
 * Reads and removes the note, always. True when it names `pid`, the engine whose running marker
 * was found, and is not older than the limit (nor more than a few minutes in the future): a crash
 * of any other engine is still a crash. If the signal found the engine already gone (ESRCH) it
 * had died on its own just before; that window is a few milliseconds and is accepted.
 */
export async function takeStoppedByApp(dir: string, pid: number | undefined, now: number): Promise<boolean> {
  const path = join(dir, STOPPED_BY_APP_FILE);
  const read = await readJsonFile(path, { maxBytes: 256 });
  // Removed whatever it held (a link or a damaged file too): a note is honoured once.
  try {
    unlinkSync(path);
  } catch {
    // Gone already.
  }
  if (!read.ok) return false;
  const note = read.value;
  if (typeof note !== "object" || note === null) return false;
  const { pid: notedPid, at } = note as { pid?: unknown; at?: unknown };
  return pid !== undefined && notedPid === pid && typeof at === "number" && at <= now + FUTURE_SLACK_MS && now - at <= STOPPED_BY_APP_MAX_AGE_MS;
}
