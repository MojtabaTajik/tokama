// The crash prompt: after Tokama or its engine stopped unexpectedly, the next start asks once
// whether to send a report. Review and send opens Settings > Diagnostics; nothing is sent from here.
// Every button marks the crash seen, so it asks once per crash, and at most once per run.
import { useEffect, useRef, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

const TEXT = {
  title: "Tokama stopped unexpectedly. Send a report?",
  label: "Tokama stopped unexpectedly",
  text: "Review and send opens Diagnostics. Nothing is sent until you click Send all there.",
  dontAsk: "Don’t ask again",
  notNow: "Not now",
  review: "Review and send",
} as const;

/** Whether the prompt shows, and what its buttons do. `askAfterCrash`: false after Don't ask again. */
export function useCrashPrompt(bridge: TokamaBridge, connection: ConnectionState, askAfterCrash: boolean) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState(0);
  // Once per run: after it showed, a later crash waits for the next start.
  const shown = useRef(false);
  const ask = useRef(askAfterCrash);
  const connected = connection.status === "connected";
  // A crash is recorded with a setup_changed event; the flag is read again then.
  useEffect(() => bridge.onEvent(({ event }) => event.type === "setup_changed" && setChecks((n) => n + 1)), [bridge]);
  useEffect(() => {
    if (!connected || shown.current || !ask.current) return;
    let current = true;
    bridge
      .query({ type: "diagnostics_settings" })
      .then((reply) => {
        if (!current || shown.current || !reply.ok || !reply.data.crashWaiting) return;
        shown.current = true;
        setOpen(true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, connected, checks]);
  const close = () => {
    setOpen(false);
    void bridge.command({ type: "diagnostics_settings", crashSeen: true }).catch(() => undefined);
  };
  return {
    open,
    notNow: close,
    review: close,
    dontAsk: () => {
      ask.current = false;
      close();
      void bridge.stopCrashPrompt().catch(() => undefined);
    },
  };
}

export function CrashPrompt({ onReview, onNotNow, onDontAsk }: { readonly onReview: () => void; readonly onNotNow: () => void; readonly onDontAsk: () => void }) {
  const review = useRef<HTMLButtonElement>(null);
  useEffect(() => review.current?.focus(), []);
  return (
    <div className="crash-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={TEXT.label}
        className="crash-prompt"
        onKeyDown={(event) => {
          if (event.key === "Escape") onNotNow();
        }}
      >
        <div className="crash-prompt-body">
          <h2 className="crash-prompt-title">{TEXT.title}</h2>
          <p className="crash-prompt-text">{TEXT.text}</p>
        </div>
        <div className="crash-prompt-actions">
          <button type="button" className="dg-button" onClick={onDontAsk}>
            {TEXT.dontAsk}
          </button>
          <button type="button" className="dg-button" onClick={onNotNow}>
            {TEXT.notNow}
          </button>
          <button type="button" className="dg-button dg-primary" ref={review} onClick={onReview}>
            {TEXT.review}
          </button>
        </div>
      </div>
    </div>
  );
}
