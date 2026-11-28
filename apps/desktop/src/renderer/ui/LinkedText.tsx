// Text from the engine, shown as text, with one exception: the address of a known page on the
// product site becomes a link that opens in the browser. Nothing else in the text is ever a link
// or markup, and the link's address is one of the constants below, never a guess from the text.
import { Fragment } from "react";
import { ExternalLink } from "./ExternalLink.js";

/** The pages whose address may stand in engine text; each must also be in the main process's allowlist. */
export const LINKABLE_URLS: readonly string[] = ["https://tokama.dev/docs/linux-sandbox"];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// An address counts only as a whole word: not inside a longer one, and not followed by more path.
const ADDRESS = new RegExp(`(?<=^|[\\s("'\`])(${LINKABLE_URLS.map(escape).join("|")})(?![\\w/?#%@~:=&+-])(?!\\.\\w)`, "g");

/** `text` split into plain pieces and the known addresses in it, in order; a link piece carries the listed address as `href`. */
export function splitLinkable(text: string): readonly { readonly text: string; readonly href?: string }[] {
  const pieces: { text: string; href?: string }[] = [];
  let from = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const href = LINKABLE_URLS.find((url) => url === match[0]);
    if (href === undefined) continue;
    if (match.index > from) pieces.push({ text: text.slice(from, match.index) });
    pieces.push({ text: href, href });
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from) });
  return pieces;
}

export function LinkedText({ text }: { readonly text: string }) {
  return (
    <>
      {splitLinkable(text).map((piece, index) => (
        <Fragment key={index}>{piece.href === undefined ? piece.text : <ExternalLink href={piece.href}>{piece.text}</ExternalLink>}</Fragment>
      ))}
    </>
  );
}
