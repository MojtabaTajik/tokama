// The two ways the notifier shows a note: through the system (Electron's Notification), or, in
// UI tests, into a list the test reads and clicks, so a test run never pops a real banner.
import { Notification } from "electron";
import type { Note } from "./notifier.js";

export type ShowNote = (note: Note, onClick: () => void) => void;

/** A shown notification that has not been clicked or closed must stay referenced, or its click is lost. */
const MAX_LIVE = 50;

export function systemShow(): ShowNote {
  const live: Notification[] = [];
  return (note, onClick) => {
    try {
      if (!Notification.isSupported()) return;
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
      shown.on("failed", forget);
      live.push(shown);
      if (live.length > MAX_LIVE) live.shift();
      shown.show();
    } catch {
      // No permission or no notification service: the switches still work and nothing else breaks.
    }
  };
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
  };
}
