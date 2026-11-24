// The template the engine suggests for the text being typed. The query waits for a pause in
// typing; blank text asks nothing and clears the suggestion; a reply for text that has changed
// since is dropped; an error clears the suggestion. Each suggestion is stored with the text it
// was asked for and is `fresh` only while that text is the current text: until the next reply the
// old template can still be shown, but not started with.
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";

export const SUGGEST_DELAY_MS = 250;

export interface Suggestion {
  readonly templateId: string;
  /** The suggestion was made for the text as it is now. */
  readonly fresh: boolean;
}

export function useSuggestion(bridge: TokamaBridge, text: string, delayMs = SUGGEST_DELAY_MS): Suggestion | undefined {
  const [suggested, setSuggested] = useState<{ readonly text: string; readonly templateId: string } | undefined>(undefined);
  const asked = text.trim();
  useEffect(() => {
    if (asked === "") {
      setSuggested(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void bridge
        .query({ type: "suggest_template", text: asked })
        .then((reply) => {
          if (current) setSuggested(reply.ok && reply.data.templateId !== null ? { text: asked, templateId: reply.data.templateId } : undefined);
        })
        .catch(() => {
          if (current) setSuggested(undefined);
        });
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [bridge, asked, delayMs]);
  return asked === "" || suggested === undefined ? undefined : { templateId: suggested.templateId, fresh: suggested.text === asked };
}
