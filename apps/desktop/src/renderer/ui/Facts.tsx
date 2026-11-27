// A facts line: what Tokama measured, as short parts in mono ("checks 3/3 · stopped at Build,
// step 2 of 3"). A part that is not normal starts with its symbol in colour; its words stay in the
// text colour, and the symbol has a word for screen readers, so colour is never the only signal.
// Engine text is rendered as React text only.
import { type CSSProperties, Fragment, useId } from "react";
import type { Fact } from "../../shared/item-facts.js";
import { Tooltip } from "./Tooltip.js";
import { useHostTip } from "./useTip.js";

/** The whole line as plain text, with the symbol of an exception. */
export const factsText = (facts: readonly Fact[]): string => facts.map((fact) => (fact.mark === undefined ? fact.text : `${fact.mark.symbol} ${fact.text}`)).join(" · ");

/**
 * The line is cut with an ellipsis where it does not fit; the whole line shows in the shared tooltip while the
 * pointer is on the row or card around it, or the keyboard focus is on that row or card's button.
 */
export function Facts({ facts, className }: { readonly facts: readonly Fact[]; readonly className?: string | undefined }) {
  const { ref, open } = useHostTip(facts.length > 0);
  const anchor = `--facts-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (facts.length === 0) return null;
  return (
    <>
      <span ref={ref} className={["facts", "mono", className].filter(Boolean).join(" ")} style={{ anchorName: anchor } as CSSProperties}>
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
      {open && (
        <Tooltip id={`${anchor.slice(2)}-tip`} anchor={anchor} className="facts-tip">
          {factsText(facts)}
        </Tooltip>
      )}
    </>
  );
}
