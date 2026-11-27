// The crash prompt: after Tokama or its engine stopped unexpectedly, the next start asks once
// whether to send a report. Review and send opens Settings > Diagnostics; nothing is sent from here.
// Every button marks the crash seen, so it asks once per crash, and at most once per run.
import { useEffect, useRef, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { Button } from "../ui/Button.js";
import { Modal } from "../ui/Modal.js";

const TEXT = {
  title: "Tokama stopped unexpectedly. Send a report?",
  label: "Tokama stopped unexpectedly",
  text: "Review and send opens Diagnostics. Nothing is sent until you click Send all there.",
  dontAsk: "Don’t ask again",
  notNow: "Not now",
  review: "Review and send",
} as const;

/** Whether the prompt shows, whether asking is still on, and what its buttons do. `askAfterCrash`: false after Don't ask again. */
export function useCrashPrompt(bridge: TokamaBridge, connection: ConnectionState, askAfterCrash: boolean) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState(0);
  // Once per run: after it showed, a later crash waits for the next start.
  const shown = useRef(false);
  const ask = useRef(askAfterCrash);
  // The same flag for the render: the rail's mark on Settings goes with Don't ask again.
  const [asking, setAsking] = useState(askAfterCrash);
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
    asking,
    notNow: close,
    review: close,
    dontAsk: () => {
      ask.current = false;
      setAsking(false);
      close();
      void bridge.stopCrashPrompt().catch(() => undefined);
    },
  };
}

export function CrashPrompt({ onReview, onNotNow, onDontAsk }: { readonly onReview: () => void; readonly onNotNow: () => void; readonly onDontAsk: () => void }) {
  const review = useRef<HTMLButtonElement>(null);
  useEffect(() => review.current?.focus(), []);
  return (
    <Modal label={TEXT.label} className="crash-prompt" onClose={onNotNow}>
      <div className="crash-prompt-body">
        <h2 className="crash-prompt-title">{TEXT.title}</h2>
        <p className="crash-prompt-text">{TEXT.text}</p>
      </div>
      <div className="crash-prompt-actions">
        <Button variant="secondary" size="lg" onClick={onDontAsk}>
          {TEXT.dontAsk}
        </Button>
        <Button variant="secondary" size="lg" onClick={onNotNow}>
          {TEXT.notNow}
        </Button>
        <Button variant="primary" size="lg" ref={review} onClick={onReview}>
          {TEXT.review}
        </Button>
      </div>
    </Modal>
  );
}
