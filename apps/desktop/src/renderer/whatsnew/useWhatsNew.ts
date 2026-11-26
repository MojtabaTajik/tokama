// The release notes in the window: asks the main process once, and tracks what the user has shown
// or closed this run, so a card or chip goes at once. The main process remembers it for the next
// start. An answer that fails leaves no card and no chip; About says the notes could not be read.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokamaBridge, WhatsNewInfo } from "../../shared/bridge.js";
import type { Note } from "../../shared/whats-new.js";

export interface WhatsNewView {
  /** The notes, `"failed"` when they could not be read, undefined while they load. */
  readonly info: WhatsNewInfo | "failed" | undefined;
  /** The note of the card still to show. */
  readonly card: Note | undefined;
  /** The note of the "Updated to" chip still to show. */
  readonly chip: { readonly note: Note; readonly kind: "fixes" | "security" } | undefined;
  /** The card is closed (Got it, See all or Escape): it never shows again. */
  closeCard(): void;
  /** The chip is on screen: it never shows again after this run. */
  chipShown(): void;
  /** The chip is gone from the screen for this run. */
  chipGone(): void;
}

export function useWhatsNew(bridge: TokamaBridge): WhatsNewView {
  const [info, setInfo] = useState<WhatsNewInfo | "failed" | undefined>(undefined);
  // What this run has finished with, as "card:<version>" or "chip:<version>".
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const told = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    // Called inside a promise, so a bridge that throws at once fails the same quiet way as one that rejects.
    Promise.resolve()
      .then(() => bridge.getWhatsNew())
      .then((next) => live && setInfo(next), () => live && setInfo("failed"));
    return () => {
      live = false;
    };
  }, [bridge]);

  const ready = typeof info === "object" ? info : undefined;
  const cardVersion = ready?.due?.card;
  const chipDue = ready?.due?.chip;
  const cardNote = cardVersion === undefined ? undefined : ready?.notes.find((note) => note.version === cardVersion);
  const chipNote = chipDue === undefined ? undefined : ready?.notes.find((note) => note.version === chipDue.version);

  const tell = useCallback(
    (version: string, what: "card" | "chip") => {
      const key = `${what}:${version}`;
      if (told.current.has(key)) return;
      told.current.add(key);
      void bridge.closeWhatsNew(version, what).catch(() => undefined);
    },
    [bridge],
  );
  const finish = useCallback((key: string) => setDone((now) => (now.has(key) ? now : new Set(now).add(key))), []);

  const closeCard = useCallback(() => {
    if (cardVersion === undefined) return;
    tell(cardVersion, "card");
    finish(`card:${cardVersion}`);
  }, [cardVersion, tell, finish]);
  const chipShown = useCallback(() => {
    if (chipDue !== undefined) tell(chipDue.version, "chip");
  }, [chipDue, tell]);
  const chipGone = useCallback(() => {
    if (chipDue !== undefined) finish(`chip:${chipDue.version}`);
  }, [chipDue, finish]);

  return {
    info,
    card: cardNote !== undefined && !done.has(`card:${cardNote.version}`) ? cardNote : undefined,
    chip: chipNote !== undefined && chipDue !== undefined && !done.has(`chip:${chipNote.version}`) ? { note: chipNote, kind: chipDue.kind } : undefined,
    closeCard,
    chipShown,
    chipGone,
  };
}
