// What a release note says, as the card and About's history show it: the security line, the
// highlights (title, sentence, where to find it) and the count of smaller fixes. Every string
// comes from a note file and renders as a text node: no HTML, no Markdown, no link.
import type { Note } from "../../shared/whats-new.js";
import { ShieldIcon } from "../ui/icons.js";
import { TEXT } from "./words.js";

export function NoteBody({ note }: { readonly note: Note }) {
  return (
    <>
      {note.security && (
        <p className="wn-security">
          <span className="wn-security-icon">
            <ShieldIcon />
          </span>
          <span>
            <span className="wn-security-word">{TEXT.security} · </span>
            {TEXT.securityLine}
          </span>
        </p>
      )}
      {note.highlights.length > 0 && (
        <ul className="wn-highlights">
          {note.highlights.map((highlight) => (
            <li key={highlight.title} className="wn-highlight">
              <span className="wn-highlight-title">{highlight.title}</span>
              <span className="wn-highlight-text">{highlight.text}</span>
              {highlight.where !== undefined && <span className="wn-highlight-where">{highlight.where}</span>}
            </li>
          ))}
        </ul>
      )}
      {note.fixes > 0 && <p className="wn-fixes">{TEXT.fixesLine(note.fixes)}</p>}
    </>
  );
}
