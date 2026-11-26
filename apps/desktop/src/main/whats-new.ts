// Release notes in the main process. The notes ship with the app as `whats-new/<version>.md`; this
// reads the ones up to the app's own version through the kernel's safe read, and decides at each
// start whether the version just installed has a card or a chip to show. What is due is saved in
// `desktop.json` until the user closes the card or the chip first shows, so quitting in between
// loses nothing, and one note is never shown twice. The renderer never reads a file or a path.
import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasCode, readTextFile } from "@tokama/core";
import type { WhatsNewInfo } from "../shared/bridge.js";
import type { DesktopState, WhatsNewDue } from "../shared/desktop-state.js";
import { compareVersions, isVersion, MAX_NOTE_BYTES, type Note, noteKind, parseNote } from "../shared/whats-new.js";
import type { DesktopStore } from "./desktop-store.js";
import { e2eEnabled } from "./policy.js";

/** The most notes the app reads: the newest ones up to its own version. */
export const MAX_NOTES = 100;

/**
 * The folder of the notes: `Resources/whats-new` in a packaged app, the checkout's `whats-new`
 * in development. The UI tests point `override` at a fixture folder; it counts only when the test
 * flag is on in an app that is not packaged.
 */
export function notesDir(options: { readonly packaged: boolean; readonly resourcesPath: string; readonly appPath: string; readonly e2e: string | undefined; readonly override: string | undefined }): string {
  if (options.override !== undefined && options.override !== "" && e2eEnabled(options.e2e, options.packaged)) return options.override;
  return options.packaged ? join(options.resourcesPath, "whats-new") : join(options.appPath, "..", "..", "whats-new");
}

/** Whether something is at `path`, a link counted as itself. */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The notes in `dir` named `<x.y.z>.md` for a version up to `appVersion`, newest first, at most
 * `MAX_NOTES`. A missing folder holds none. A file that cannot be read safely or does not parse is
 * skipped and named to `log`; the others still load. Throws only when the folder cannot be listed.
 */
export async function loadNotes(dir: string, appVersion: string, log: (message: string) => void): Promise<Note[]> {
  if (!isVersion(appVersion)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return [];
    throw error;
  }
  const versions = names
    .filter((name) => name.endsWith(".md") && isVersion(name.slice(0, -3)))
    .map((name) => name.slice(0, -3))
    .filter((version) => compareVersions(version, appVersion) <= 0)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, MAX_NOTES);
  const notes: Note[] = [];
  for (const version of versions) {
    const file = `${version}.md`;
    const read = await readTextFile(join(dir, file), { maxBytes: MAX_NOTE_BYTES });
    if (!read.ok) {
      log(`whats-new/${file}: ${read.error.message}`);
      continue;
    }
    const parsed = parseNote(read.value, file);
    if (parsed.ok) notes.push(parsed.note);
    else log(`whats-new/${file}: ${parsed.problems.join("; ")}`);
  }
  return notes;
}

/**
 * What is due after this start. `fileExisted`: desktop.json was there before this run (without it
 * this is a first install, not an update). The same version as last time changes nothing, so a card
 * not yet closed stays due. An older version than last time shows nothing. Otherwise only the note of
 * the version just installed counts, also across skipped versions and for a file with no recorded
 * version: highlights make a card, fixes or security make a chip, no note makes nothing.
 */
export function dueAfterStart(options: { readonly fileExisted: boolean; readonly lastRunVersion: string | undefined; readonly appVersion: string; readonly notes: readonly Note[]; readonly pending: WhatsNewDue | undefined }): WhatsNewDue | undefined {
  const { fileExisted, lastRunVersion, appVersion, notes, pending } = options;
  if (lastRunVersion === appVersion) return pending;
  if (!fileExisted || !isVersion(appVersion)) return undefined;
  if (lastRunVersion !== undefined && compareVersions(appVersion, lastRunVersion) < 0) return undefined;
  const note = notes.find((candidate) => candidate.version === appVersion);
  if (note === undefined) return undefined;
  return noteKind(note) === "highlights" ? { card: appVersion } : { chip: appVersion };
}

/** `state` with `due` as its due notes, and none when `due` is undefined. */
function withDue(state: DesktopState, due: WhatsNewDue | undefined): DesktopState {
  const next: { -readonly [K in keyof DesktopState]: DesktopState[K] } = { ...state };
  delete next.whatsNewDue;
  if (due !== undefined && (due.card !== undefined || due.chip !== undefined)) next.whatsNewDue = due;
  return next;
}

export interface WhatsNewService {
  /** The notes, and what is due; waits for the start-up read. */
  info(): Promise<WhatsNewInfo>;
  /** Clears the due card or chip when `version` is the one due; any other input is ignored. */
  close(version: unknown, what: unknown): void;
}

export interface WhatsNewDeps {
  readonly store: Pick<DesktopStore, "get" | "update">;
  readonly dir: string;
  readonly appVersion: string;
  /** desktop.json was there before this run. */
  readonly fileExisted: boolean;
  readonly log: (message: string) => void;
}

/**
 * Reads the notes once, now, and records this run's version in the store. When the folder cannot
 * be listed, no version is recorded, so a later start can still show the note; the app goes on
 * without notes.
 */
export function whatsNewService(deps: WhatsNewDeps): WhatsNewService {
  const { store, dir, appVersion, fileExisted, log } = deps;
  const loaded = (async (): Promise<readonly Note[]> => {
    try {
      const notes = await loadNotes(dir, appVersion, log);
      const { lastRunVersion, whatsNewDue } = store.get();
      const due = dueAfterStart({ fileExisted, lastRunVersion, appVersion, notes, pending: whatsNewDue });
      store.update((state) => ({ ...withDue(state, due), ...(isVersion(appVersion) ? { lastRunVersion: appVersion } : {}) }));
      return notes;
    } catch (error) {
      log(`could not read the release notes: ${String(error)}`);
      return [];
    }
  })();
  return {
    info: async () => {
      const notes = await loaded;
      const due = store.get().whatsNewDue;
      const kindOf = (version: string | undefined) => {
        const note = version === undefined ? undefined : notes.find((candidate) => candidate.version === version);
        return note === undefined ? undefined : noteKind(note);
      };
      const cardVersion = due?.card;
      const card = cardVersion !== undefined && kindOf(cardVersion) === "highlights" ? cardVersion : undefined;
      const chipVersion = due?.chip;
      const chipKind = kindOf(chipVersion);
      const chip = chipVersion !== undefined && (chipKind === "fixes" || chipKind === "security") ? { version: chipVersion, kind: chipKind } : undefined;
      return { appVersion, notes, ...(card === undefined && chip === undefined ? {} : { due: { ...(card === undefined ? {} : { card }), ...(chip === undefined ? {} : { chip }) } }) };
    },
    close: (version, what) => {
      if (typeof version !== "string" || (what !== "card" && what !== "chip")) return;
      const due = store.get().whatsNewDue;
      if (due === undefined || due[what] !== version) return;
      store.update((state) => withDue(state, what === "card" ? (due.chip === undefined ? undefined : { chip: due.chip }) : due.card === undefined ? undefined : { card: due.card }));
    },
  };
}
