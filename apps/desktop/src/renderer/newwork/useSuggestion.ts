// The template the engine suggests for the text being typed. The query waits for a pause in
// typing; blank text asks nothing and has no suggestion; a reply for text that has changed since
// is dropped. The last suggestion stays while newer text is being asked, so the mark does not
// flicker; an error leaves it as it was.
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";

export const SUGGEST_DELAY_MS = 250;

export function useSuggestion(bridge: TokamaBridge, text: string, delayMs = SUGGEST_DELAY_MS): string | undefined {
  const [suggested, setSuggested] = useState<string | undefined>(undefined);
  useEffect(() => {
    const asked = text.trim();
    if (asked === "") return;
    let current = true;
    const timer = setTimeout(() => {
      void bridge
        .query({ type: "suggest_template", text: asked })
        .then((reply) => {
          if (current && reply.ok) setSuggested(reply.data.templateId ?? undefined);
        })
        .catch(() => undefined);
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [bridge, text, delayMs]);
  return text.trim() === "" ? undefined : suggested;
}
