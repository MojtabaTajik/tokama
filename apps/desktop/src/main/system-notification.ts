// The two ways the notifier shows a note: through the system (Electron's Notification), or, in
// UI tests, into a list the test reads and clicks, so a test run never pops a real banner.
import { Notification } from "electron";
import type { Note } from "./notifier.js";

/** Shows the note; true when it was handed to the system, false when there is no notification service or it refused. */
export type ShowNote = (note: Note, onClick: () => void) => boolean;

/** A shown notification that has not been clicked or closed must stay referenced, or its click is lost. */
const MAX_LIVE = 50;

export interface SystemNotifications {
  readonly show: ShowNote;
  /**
   * Whether the system turned the last notification down: no notification service, a refusal when it
   * was shown, or the system's `failed` event (which macOS sends when the app is not allowed to show
   * notifications). Electron has no call that reads the permission itself, so a banner has to be
   * tried first; a later banner that appears clears it.
   */
  readonly blocked: () => boolean;
}

export function systemNotifications(): SystemNotifications {
  const live: Notification[] = [];
  let blocked = false;
  const show: ShowNote = (note, onClick) => {
    try {
      if (!Notification.isSupported()) {
        blocked = true;
        return false;
      }
      const shown = new Notification({ title: note.title, body: note.body, silent: note.silent, ...(note.sound === undefined ? {} : { sound: note.sound }) });
      const forget = () => {
        const index = live.indexOf(shown);
        if (index !== -1) live.splice(index, 1);
      };
      shown.on("click", () => {
        forget();
        onClick();
      });
      shown.on("close", forget);
      shown.on("show", () => {
        blocked = false;
      });
      shown.on("failed", () => {
        blocked = true;
        forget();
      });
      live.push(shown);
      if (live.length > MAX_LIVE) live.shift();
      shown.show();
      return true;
    } catch {
      // No permission or no notification service: the choices still work and nothing else breaks.
      blocked = true;
      return false;
    }
  };
  return { show, blocked: () => blocked };
}

/** What a test sees of a note: its text, and `click` for the engineer's click. */
export interface RecordedNote extends Note {
  readonly click: () => void;
}

/** Keeps the notes in `globalThis.__tokamaNotifications`, where a test reads them through `app.evaluate`. */
export function recordingShow(): ShowNote {
  const list: RecordedNote[] = [];
  (globalThis as { __tokamaNotifications?: RecordedNote[] }).__tokamaNotifications = list;
  return (note, onClick) => {
    list.push({ ...note, click: onClick });
    return true;
  };
}
