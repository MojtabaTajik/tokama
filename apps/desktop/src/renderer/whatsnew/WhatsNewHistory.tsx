// About's What's new: the notes of this version and the earlier ones, newest first, each a row that
// opens to what the note says. Opened through the card's See all or the chip, one row starts open
// and the heading takes the focus. The only link is the product site, which the window sends to
// the system browser. Notes render as text.
import { useEffect, useRef, useState } from "react";
import type { WhatsNewInfo } from "../../shared/bridge.js";
import { type Note, noteKind } from "../../shared/whats-new.js";
import { Button } from "../ui/Button.js";
import { Placeholder } from "../ui/EmptyState.js";
import { NoteBody } from "./NoteBody.js";
import { TEXT } from "./words.js";

export interface WhatsNewHistoryProps {
  /** The notes, `"failed"` when they could not be read, undefined while they load. */
  readonly info: WhatsNewInfo | "failed" | undefined;
  /** This row starts open, and the section scrolls into view. */
  readonly openVersion?: string | undefined;
  /** The product site, About's one outside link. */
  readonly siteUrl: string;
}

/** The kind word of a row: "2 highlights", "Security" or "Fixes". */
export function kindWord(note: Note): string {
  const kind = noteKind(note);
  return kind === "highlights" ? TEXT.kindHighlights(note.highlights.length) : kind === "security" ? TEXT.kindSecurity : TEXT.kindFixes;
}

export function WhatsNewHistory({ info, openVersion, siteUrl }: WhatsNewHistoryProps) {
  const ready = typeof info === "object" ? info : undefined;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(openVersion === undefined ? [] : [openVersion]));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (openVersion === undefined) return;
    setOpen((now) => (now.has(openVersion) ? now : new Set(now).add(openVersion)));
    // happy-dom has no scrollIntoView.
    heading.current?.scrollIntoView?.({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, [openVersion]);
  const toggle = (version: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (!next.delete(version)) next.add(version);
      return next;
    });

  return (
    <section aria-labelledby="about-whats-new" className="wn-section">
      <div className="wn-section-head">
        <h2 id="about-whats-new" ref={heading} tabIndex={-1} className="wn-heading">
          {TEXT.heading}
        </h2>
        {ready !== undefined && <span className="wn-count">{ready.notes.length}</span>}
        <a href={siteUrl} target="_blank" rel="noreferrer noopener" className="wn-site">
          {TEXT.site}
          <span aria-hidden="true">↗</span>{/* status-guard: not a status, an outside link */}
        </a>
      </div>
      {ready === undefined ? (
        <p className="wn-soft">{info === "failed" ? TEXT.failed : TEXT.loading}</p>
      ) : ready.notes.length === 0 ? (
        <Placeholder>{TEXT.empty}</Placeholder>
      ) : (
        <ul className="wn-list">
          {ready.notes.map((note) => {
            const expanded = open.has(note.version);
            return (
              <li key={note.version} className="wn-item">
                <Button variant="plain" className="wn-head" aria-expanded={expanded} onClick={() => toggle(note.version)}>
                  <span aria-hidden="true" className="wn-chev">
                    {expanded ? "▾" : "▸"}
                  </span>
                  <span className="wn-name">
                    <span className="wn-version mono">{note.version}</span>
                    <span className="wn-role">{kindWord(note)}</span>
                    {note.version === ready.appVersion && <span className="wn-role">{TEXT.thisVersion}</span>}
                  </span>
                  <span className="wn-date">{note.date}</span>
                </Button>
                {expanded && (
                  <div className="wn-body wn-note">
                    <NoteBody note={note} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
