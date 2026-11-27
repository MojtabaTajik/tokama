// Settings > Notifications: how each kind of system notification about items reaches you (a banner
// with a sound, a banner alone, a sound alone or nothing), which sounds play, a ▶ button that plays a
// kind's sound, and a preview of how each one looks. The choices are remembered in the desktop
// settings file; the main process shows the notifications and plays the sounds. The preview texts
// are samples, rendered as React text.
import { useEffect, useRef, useState } from "react";
import type { NotificationStatus, TokamaBridge } from "../../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE, NOTE_KINDS, type NoteKind, type NoteMode, type NotificationSettings, type SoundSet } from "../../shared/desktop-state.js";
import { failureLine, finishedLine } from "../../shared/item-facts.js";
import { brand } from "../brand/index.js";
import { Button } from "../ui/Button.js";
import { Segmented } from "../ui/Segmented.js";
import { markOf, type Tone } from "../ui/status.js";

const TEXT = {
  heading: "Notifications",
  intro: "macOS notifications about your items. Click one to open its item in Tokama.",
  soundsName: "Sounds",
  soundsHelp: "Used by Banner + sound and Sound only. The ▶ buttons play it too, whatever a row is set to.",
  infoLooking: "No notification while you are looking at that item: Tokama is in front and the item is open in the drawer or the full view.",
  infoSoundOnly: "Sound only: macOS cannot play a sound without a banner, so Tokama plays it itself while the app is running. Sounds play even during Focus, but not while your Mac is locked. Choose Banner only for a row if that bothers you. The ▶ buttons always play.",
  preview: "Preview",
  previewHint: "How each one looks in the top-right corner of the screen. Plain text, no formatting.",
  now: "now",
  playing: "Playing",
  silent: "Silent. No kind plays a sound.",
  testName: "Test",
  testHelp: "Shows one banner and plays the Needs you sound, the way a real event does. A locked screen keeps the sound quiet.",
  testHelpMac: " After you allow notifications in System Settings, send a test to check.",
  testButton: "Send a test notification",
  blockedMac: "macOS is not showing Tokama's notifications.",
  blockedOpen: "Open System Settings › Notifications",
  blockedOther: "No notification service answered. Check that one is running.",
} as const;

/** How long after a test the page asks again whether the system turned the banner down: the refusal comes a moment later. */
const STATUS_RECHECK_MS = 1_000;

const MODES: readonly { readonly value: NoteMode; readonly label: string }[] = [
  { value: "both", label: "Banner + sound" },
  { value: "banner", label: "Banner only" },
  { value: "sound", label: "Sound only" },
  { value: "off", label: "Off" },
];
const SOUND_SETS: readonly { readonly value: SoundSet; readonly label: string }[] = [
  { value: "tokama", label: "Tokama sounds" },
  { value: "macos", label: "macOS default" },
];
/** How the chosen sound set is named in the preview lines. */
const SOUND_NAME: Record<SoundSet, string> = { tokama: "Tokama sound", macos: "macOS default sound" };

const ROWS: readonly { readonly key: NoteKind; readonly name: string; readonly glyph: string; readonly tone: Tone | "quiet"; readonly help: string }[] = [
  { key: "needsYou", name: "Needs you", glyph: markOf("needs_you").symbol, tone: "warn", help: "An item waits for your decision, like approving a plan or a change." },
  { key: "finished", name: "Finished", glyph: markOf("done").symbol, tone: "pass", help: "An item is done and ready to merge, open a PR or discard." },
  { key: "failed", name: "Failed", glyph: markOf("failed").symbol, tone: "fail", help: "An item stopped because a step failed." },
];

/** Sample items the Finished and Failed previews word with the same functions as the real banners. */
const sampleCheck = (command: string, passed: boolean) => ({ command, passed, exitCode: passed ? 0 : 1 });
const SAMPLE_DONE = {
  steps: [{ attempts: [{ checks: ["pnpm typecheck", "pnpm lint", "pnpm test"].map((command) => sampleCheck(command, true)) }] }],
  outcome: undefined,
} as unknown as Parameters<typeof finishedLine>[0];
const SAMPLE_FAILED = {
  steps: [
    { name: "Plan", state: "passed" },
    { name: "Build", state: "failed", attempts: [1, 2, 3].map(() => ({ checks: [sampleCheck("pnpm test", false)] })) },
    { name: "Review", state: "pending" },
  ],
} as unknown as Parameters<typeof failureLine>[0];

const PREVIEWS: readonly { readonly key: NoteKind; readonly title: string; readonly body: string; readonly meta: string }[] = [
  { key: "needsYou", title: "Needs you: Add order export endpoint", body: "The plan is ready. Approve it to start Build.", meta: "Plan and build · orders-api" },
  { key: "finished", title: "Finished: Fix the null check in cart totals", body: finishedLine(SAMPLE_DONE, "9 min", true), meta: "Quick fix · checkout-web" },
  { key: "failed", title: "Failed: Upgrade the Postgres driver", body: failureLine(SAMPLE_FAILED), meta: "Plan and build · orders-api" },
];

/** How long "Playing" stays beside a ▶ button. */
const PLAYING_MS = 1_400;

export interface NotificationsPageProps {
  readonly bridge: TokamaBridge;
}

export function NotificationsPage({ bridge }: NotificationsPageProps) {
  // Undefined until the saved choices are read, so the page never shows the defaults for a moment.
  const [values, setValues] = useState<NotificationSettings | undefined>(undefined);
  const [playing, setPlaying] = useState<NoteKind | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
  useEffect(() => () => clearTimeout(timer.current), []);

  // Whether the system turned the last notification down. The system cannot be asked, so this only
  // changes when a banner is tried: by an event, or by the test button.
  const [status, setStatus] = useState<NotificationStatus | undefined>(undefined);
  const recheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void bridge
      .notificationStatus()
      .then((next) => live && setStatus(next))
      .catch(() => undefined);
    return () => {
      live = false;
      clearTimeout(recheck.current);
    };
  }, [bridge]);
  const sendTest = () => {
    void bridge.sendTestNotification().catch(() => undefined);
    clearTimeout(recheck.current);
    recheck.current = setTimeout(() => void bridge.notificationStatus().then(setStatus).catch(() => undefined), STATUS_RECHECK_MS);
  };

  const choose = (patch: Partial<NotificationSettings>) => {
    if (values === undefined) return;
    setValues({ ...values, ...patch });
    void bridge.saveNotifications(patch).catch(() => undefined);
  };
  const play = (kind: NoteKind) => {
    if (values === undefined) return;
    void bridge.playSound(kind, values.sounds).catch(() => undefined);
    setPlaying(kind);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPlaying(undefined), PLAYING_MS);
  };

  const soundName = values === undefined ? "" : SOUND_NAME[values.sounds];
  const plays = values === undefined ? 0 : NOTE_KINDS.filter((kind) => values[kind] === "both" || values[kind] === "sound").length;

  return (
    <section className="notes" aria-labelledby="notes-heading">
      <div className="notes-body">
        <h1 id="notes-heading" className="notes-heading">
          {TEXT.heading}
        </h1>
        <p className="notes-intro">{TEXT.intro}</p>
        {status?.blocked && (
          <div className="notes-blocked" role="status">
            <span className="notes-glyph notes-warn" aria-hidden="true">
              !
            </span>
            <span className="notes-blocked-text">{status.canOpenSettings ? TEXT.blockedMac : TEXT.blockedOther}</span>
            {status.canOpenSettings && (
              <Button variant="secondary" onClick={() => void bridge.openNotificationSettings().catch(() => undefined)}>
                {TEXT.blockedOpen}
              </Button>
            )}
          </div>
        )}
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
                <div className="notes-controls">
                  <Segmented options={MODES} value={values[row.key]} onChange={(mode) => choose({ [row.key]: mode })} labelledBy={`notes-${row.key}`} />
                  <Button variant="secondary" className="notes-play" aria-label={`Play the ${row.name} sound`} title={`Play the ${row.name} sound`} data-playing={playing === row.key || undefined} onClick={() => play(row.key)}>
                    <span aria-hidden="true">▶</span>
                  </Button>
                  {/* Always in the page, so a screen reader announces the word when it appears. */}
                  <span className="notes-playing" aria-live="polite">
                    {playing === row.key ? TEXT.playing : ""}
                  </span>
                </div>
              </div>
            ))}
            <div className="notes-row">
              <div className="notes-text">
                <span id="notes-sounds" className="notes-name">
                  <span className="notes-glyph notes-quiet" aria-hidden="true">
                    ♪
                  </span>
                  {TEXT.soundsName}
                </span>
                <span className="notes-help">{TEXT.soundsHelp}</span>
              </div>
              <Segmented options={SOUND_SETS} value={values.sounds} onChange={(sounds) => choose({ sounds })} labelledBy="notes-sounds" />
            </div>
            <div className="notes-row notes-row-last">
              <div className="notes-text">
                <span className="notes-name">
                  <span className="notes-glyph notes-quiet" aria-hidden="true">
                    ✉
                  </span>
                  {TEXT.testName}
                </span>
                <span className="notes-help">{status?.canOpenSettings ? TEXT.testHelp + TEXT.testHelpMac : TEXT.testHelp}</span>
              </div>
              <Button variant="secondary" onClick={sendTest}>
                {TEXT.testButton}
              </Button>
            </div>
            <div className="notes-info">
              <span className="notes-i" aria-hidden="true">
                i
              </span>
              <span className="notes-info-text">
                <span>{TEXT.infoLooking}</span>
                <span>{TEXT.infoSoundOnly}</span>
              </span>
            </div>
            <div className="notes-preview-head">
              <span className="notes-preview-title">{TEXT.preview}</span>
              <span className="notes-preview-hint">{TEXT.previewHint}</span>
            </div>
            <div className="notes-stage">
              {PREVIEWS.map((preview) => {
                const row = ROWS.find((candidate) => candidate.key === preview.key)!;
                const mode = values[preview.key];
                return (
                  <div key={preview.key} className="notes-slot">
                    {mode === "both" || mode === "banner" ? (
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
                      <div className="notes-card-off">{mode === "sound" ? `${row.name} is sound only: no banner, the ${soundName} plays.` : `${row.name} is off, so this one never shows.`}</div>
                    )}
                  </div>
                );
              })}
              <span className="notes-sound-note">{plays > 0 ? `♪ Plays the ${soundName} for ${plays} of 3 kinds.` : TEXT.silent}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
