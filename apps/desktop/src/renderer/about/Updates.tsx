// The Updates section of About: the state of updating in one row, with Check now, Try again or
// Restart now. A development build and a copy outside Applications show no section.
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import type { UpdateState } from "../../shared/update.js";
import { onLinux } from "../update/linux.js";
import { Button } from "../ui/Button.js";
import { updatesRow } from "./update-row.js";

export interface UpdatesProps {
  readonly bridge: TokamaBridge;
  /** Undefined until the main process has answered. */
  readonly state: UpdateState | undefined;
  /** The app's version, or undefined while About is still reading it. */
  readonly version: string | undefined;
  /** Items running now: they keep Restart now off. */
  readonly running: number;
  readonly now: number;
}

/** How long the refusal of a restart stays on screen before Restart now may be tried again. */
export const BUSY_MS = 5_000;

export function Updates({ bridge, state, version, running, now }: UpdatesProps) {
  // The engine refused the restart (it runs items the window did not list, or would not say): shown for a moment.
  const [busy, setBusy] = useState<{ readonly running?: number } | undefined>(undefined);
  useEffect(() => {
    if (busy === undefined) return;
    const timer = setTimeout(() => setBusy(undefined), BUSY_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  useEffect(() => {
    if (state?.status !== "ready") setBusy(undefined);
  }, [state?.status]);
  const row = state === undefined ? undefined : updatesRow(state, version ?? "…", running, now, busy, onLinux());
  if (row === undefined) return null;
  const { action } = row;
  const act = () => {
    if (action === undefined || action.disabled) return;
    if (action.kind === "check") {
      void bridge.checkForUpdates().catch(() => undefined);
      return;
    }
    void bridge.installUpdate().then(
      (result) => {
        if (!result.ok && result.reason === "busy") setBusy(result.running === undefined ? {} : { running: result.running });
      },
      () => undefined,
    );
  };
  return (
    <section aria-labelledby="about-updates" className="about-section">
      <div className="about-section-head">
        <h2 id="about-updates" className="about-heading">
          Updates
        </h2>
        {row.notes !== undefined && (
          <Button variant="link" className="about-action" onClick={() => void bridge.openUpdateNotes().catch(() => undefined)}>
            What's new in <span className="mono">{row.notes}</span>
          </Button>
        )}
      </div>
      <div className="about-update" aria-live="polite">
        <span aria-hidden="true" className="about-update-mark" data-tone={row.tone}>
          {row.mark}
        </span>
        <span className="about-update-text">
          <span className="about-update-main">{row.main}</span>
          {row.progress !== undefined && (
            <span role="progressbar" aria-label={row.progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.progress.percent} className="about-update-bar">
              <span className="about-update-fill" style={{ width: `${row.progress.percent}%` }} />
            </span>
          )}
          {row.sub !== undefined && <span className="about-update-sub">{row.sub}</span>}
        </span>
        {action !== undefined && (
          <Button variant={action.primary && !action.disabled ? "primary" : "secondary"} aria-disabled={action.disabled || undefined} onClick={act}>
            {action.label}
          </Button>
        )}
      </div>
    </section>
  );
}
