// Settings > Notifications: four switches for the system notifications about items, and a preview
// of how each one looks. The switches are remembered in the desktop settings file; the main
// process shows the notifications. The preview texts are samples, rendered as React text.
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE, type NotificationSettings } from "../../shared/desktop-state.js";
import { brand } from "../brand/index.js";

const TEXT = {
  heading: "Notifications",
  intro: "macOS notifications about your items. Click one to open its item in Tokama.",
  on: "On",
  off: "Off",
  info: "No notification while you are looking at that item: Tokama is in front and the item is open in the drawer or the full view.",
  preview: "Preview",
  previewHint: "How each one looks in the top-right corner of the screen. Plain text, no formatting.",
  now: "now",
  soundOn: "♪ Plays the macOS notification sound.",
  soundOff: "Silent. Sound is off.",
} as const;

type Tone = "warn" | "pass" | "fail" | "quiet";
const ROWS: readonly { readonly key: keyof NotificationSettings; readonly name: string; readonly glyph: string; readonly tone: Tone; readonly help: string }[] = [
  { key: "needsYou", name: "Needs you", glyph: "⏸", tone: "warn", help: "An item waits for your decision, like approving a plan or a change." },
  { key: "finished", name: "Finished", glyph: "✓", tone: "pass", help: "An item is done and ready to merge, open a PR or discard." },
  { key: "failed", name: "Failed", glyph: "✕", tone: "fail", help: "An item stopped because a step failed." },
  { key: "sound", name: "Sound", glyph: "♪", tone: "quiet", help: "Play the macOS notification sound with each one." },
];

const PREVIEWS: readonly { readonly key: "needsYou" | "finished" | "failed"; readonly title: string; readonly body: string; readonly meta: string }[] = [
  { key: "needsYou", title: "Needs you: Add order export endpoint", body: "The plan is ready. Approve it to start Build.", meta: "Plan and build · orders-api" },
  { key: "finished", title: "Finished: Fix the null check in cart totals", body: "Done in 9 min. Ready to merge or open a PR.", meta: "Quick fix · checkout-web" },
  { key: "failed", title: "Failed: Upgrade the Postgres driver", body: "Build failed 3 times: pnpm test, 4 failing.", meta: "Plan and build · orders-api" },
];

export interface NotificationsPageProps {
  readonly bridge: TokamaBridge;
}

export function NotificationsPage({ bridge }: NotificationsPageProps) {
  // Undefined until the saved switches are read, so the page never shows the defaults for a moment.
  const [values, setValues] = useState<NotificationSettings | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void bridge
      .getDesktopState()
      .then((state) => state.notifications)
      .catch(() => DEFAULT_DESKTOP_STATE.notifications)
      .then((saved) => {
        if (live) setValues((current) => current ?? saved);
      });
    return () => {
      live = false;
    };
  }, [bridge]);

  const flip = (key: keyof NotificationSettings) => {
    if (values === undefined) return;
    const next = !values[key];
    setValues({ ...values, [key]: next });
    void bridge.saveNotifications({ [key]: next }).catch(() => undefined);
  };

  return (
    <section className="notes" aria-labelledby="notes-heading">
      <div className="notes-body">
        <h1 id="notes-heading" className="notes-heading">
          {TEXT.heading}
        </h1>
        <p className="notes-intro">{TEXT.intro}</p>
        {values !== undefined && (
          <>
            {ROWS.map((row) => (
              <div key={row.key} className="notes-row">
                <div className="notes-text">
                  <span id={`notes-${row.key}`} className="notes-name">
                    <span className={`notes-glyph notes-${row.tone}`} aria-hidden="true">
                      {row.glyph}
                    </span>
                    {row.name}
                  </span>
                  <span className="notes-help">{row.help}</span>
                </div>
                <button type="button" className="notes-switch" role="switch" aria-checked={values[row.key]} aria-labelledby={`notes-${row.key}`} data-on={values[row.key]} onClick={() => flip(row.key)}>
                  <span className="notes-word">{values[row.key] ? TEXT.on : TEXT.off}</span>
                  <span className="notes-track">
                    <span className="notes-knob" />
                  </span>
                </button>
              </div>
            ))}
            <div className="notes-info">
              <span className="notes-i" aria-hidden="true">
                i
              </span>
              <span>{TEXT.info}</span>
            </div>
            <div className="notes-preview-head">
              <span className="notes-preview-title">{TEXT.preview}</span>
              <span className="notes-preview-hint">{TEXT.previewHint}</span>
            </div>
            <div className="notes-stage">
              {PREVIEWS.map((preview) => {
                const row = ROWS.find((candidate) => candidate.key === preview.key)!;
                return (
                  <div key={preview.key} className="notes-slot">
                    {values[preview.key] ? (
                      <div className="notes-card" role="img" aria-label={`Notification preview. ${preview.title}. ${preview.body}`}>
                        <img className="notes-icon" src={brand.markUrl} alt="" />
                        <span className="notes-card-text">
                          <span className="notes-card-top">
                            <b className="notes-card-title">{preview.title}</b>
                            <span className="notes-card-time">{TEXT.now}</span>
                          </span>
                          <span className="notes-card-body">{preview.body}</span>
                          <span className="notes-card-meta">{preview.meta}</span>
                        </span>
                      </div>
                    ) : (
                      <div className="notes-card-off">{`${row.name} is off, so this one never shows.`}</div>
                    )}
                  </div>
                );
              })}
              <span className="notes-sound-note">{values.sound ? TEXT.soundOn : TEXT.soundOff}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
