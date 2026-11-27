// A facts line: what Tokama measured, as short parts in mono ("checks 3/3 · stopped at Build,
// step 2 of 3"). A part that is not normal starts with its symbol in colour; its words stay in the
// text colour, and the symbol has a word for screen readers, so colour is never the only signal.
// Engine text is rendered as React text only.
import { Fragment } from "react";
import type { Fact } from "../../shared/item-facts.js";

export function Facts({ facts, className }: { readonly facts: readonly Fact[]; readonly className?: string | undefined }) {
  if (facts.length === 0) return null;
  // The whole line as a tooltip, for a line that is cut with an ellipsis.
  const whole = facts.map((fact) => (fact.mark === undefined ? fact.text : `${fact.mark.symbol} ${fact.text}`)).join(" · ");
  return (
    <span className={["facts", "mono", className].filter(Boolean).join(" ")} title={whole}>
      {facts.map((fact, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          {fact.mark === undefined ? (
            fact.text
          ) : (
            <span className="fact-flag">
              <span className="fact-mark" data-tone={fact.mark.tone} aria-hidden="true">
                {fact.mark.symbol}
              </span>
              <span className="visually-hidden">{fact.mark.word}: </span> {fact.text}
            </span>
          )}
        </Fragment>
      ))}
    </span>
  );
}
