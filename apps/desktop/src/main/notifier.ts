// Desktop notifications about items: when one needs the engineer, finishes or fails. The main
// process hears every item update from the engine and tells the system. No Electron here: the
// system's notification, the window and the clock come in through `NotifierDeps`, so it is tested
// with fakes. Text is plain: control characters are removed, and on Linux, where a notification
// server may read markup, `&`, `<` and `>` are escaped.
import { cutText, finishActions, type ItemRecord, type Setup } from "@tokama/core";
import type { BridgeEvent } from "../shared/bridge.js";
import type { NoteKind, NotificationSettings, SoundSet } from "../shared/desktop-state.js";
import { failureLine, finishedLine } from "../shared/item-facts.js";
import { saidOf } from "../shared/item-said.js";
import type { FocusState } from "./sound/focus.js";

export type { NoteKind };

/**
 * How a banner with a sound gets its sound. "bundled": the banner is not silent and names the
 * sound file in the app, so macOS plays it. "player": the banner is silent and the app plays the
 * same sound itself, unless a locked screen (or Focus, where it can be read) asks for quiet. The
 * app's own player is the way on macOS, which does not play a bundled sound for every build.
 */
export type BannerSound = "bundled" | "player";
export const BANNER_SOUND: BannerSound = "player";

/** Whether Sound only plays when Focus cannot be read, which it cannot on any platform now. */
export const PLAY_WHEN_FOCUS_UNKNOWN = true;

/** The line a first banner adds, once in the life of the app. */
export const HINT_LINE = "Change how Tokama notifies you in Settings → Notifications";

/** What the notifier remembers of an item: the decision it asked about and the end it reached, as far as it has seen. */
interface Seen {
  readonly decisionId?: string;
  readonly ended?: "done" | "failed";
}

const seenOf = (item: ItemRecord): Seen => ({
  ...(item.state === "needs_you" && item.decision !== undefined ? { decisionId: item.decision.id } : {}),
  ...(item.state === "done" || item.state === "failed" ? { ended: item.state } : {}),
});

/**
 * Which transitions of an item are news. It is seeded from the open items, and after that an update
 * is a transition only when it differs from what was seen: a new decision id, or an end state
 * reached now. An item seen for the first time is only recorded, and so is everything before the
 * first seed, so a restart, a reconnect or a refetch never repeats a notification.
 */
export function createTracker() {
  const seen = new Map<string, Seen>();
  let seeded = false;
  return {
    /** Replaces what is known with the open items; none of them is news. */
    seed(items: readonly ItemRecord[]): void {
      seen.clear();
      for (const item of items) seen.set(item.id, seenOf(item));
      seeded = true;
    },
    /** Forgets everything, as before the first seed: nothing is reported until the next seed. */
    reset(): void {
      seen.clear();
      seeded = false;
    },
    /** Records the update. With `loud` false (a replay after a seed) it never reports a transition. */
    observe(item: ItemRecord, loud = true): NoteKind | undefined {
      const before = seen.get(item.id);
      seen.set(item.id, seenOf(item));
      if (!loud || !seeded || before === undefined) return undefined;
      if (item.state === "needs_you" && item.decision !== undefined && item.decision.id !== before.decisionId) return "needsYou";
      if (item.state === "done" && before.ended !== "done") return "finished";
      if (item.state === "failed" && before.ended !== "failed") return "failed";
      return undefined;
    },
  };
}

/** No notification while the window is in front and shows that item (in the drawer or the full view). */
export const isSuppressed = (windowFocused: boolean, viewedItemId: string | undefined, itemId: string): boolean => windowFocused && viewedItemId === itemId;

const TITLE_MAX = 100;
const BODY_MAX = 200;

/** One line of plain text: no control or invisible formatting characters, cut to `max`, escaped for Linux. */
export function plainText(text: string, max: number, platform: NodeJS.Platform): string {
  const line = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  const short = cutText(line, max);
  // No space before the mark.
  const cut = short === line ? line : short.replace(/\s+(?=…$)/, "");
  return platform === "linux" ? cut.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") : cut;
}

/** "under 1 min", "9 min", "2 h", "1 h 5 min". */
export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

const TITLE: Record<NoteKind, string> = { needsYou: "Needs you", finished: "Finished", failed: "Failed" };

function bodyLine(kind: NoteKind, item: ItemRecord, now: number): string {
  if (kind === "needsYou") return item.decision?.question ?? "Waiting for your decision.";
  if (kind === "failed") return failureLine(item);
  return finishedLine(item, durationText(now - item.createdAt), finishActions(item).includes("merge"));
}

export interface Note {
  readonly title: string;
  /** The line about the item (a finished item's headline first, when its agent wrote one), then the template and the repos. */
  readonly body: string;
  readonly silent: boolean;
  /** The name of a sound file in the app bundle (macOS); without it, and not silent, the system's default plays. */
  readonly sound?: string;
}

/** The notification for a transition of `item`. `setup` names the template; without it the template's id stands in. */
export function noteText(kind: NoteKind, item: ItemRecord, context: { readonly setup?: Pick<Setup, "templates">; readonly now: number; readonly platform: NodeJS.Platform }): Pick<Note, "title" | "body"> {
  const template = context.setup?.templates.find((candidate) => candidate.id === item.templateId)?.name ?? item.templateId;
  const where = [template, ...(item.repoIds.length === 0 ? [] : [item.repoIds.join(", ")])].join(" · ");
  const text = (value: string, max: number) => plainText(value, max, context.platform);
  // A finished item opens with what its agent said, when the agent wrote a headline.
  const said = kind === "finished" ? saidOf(item) : undefined;
  const headline = said?.said.source === "headline" ? [text(said.said.headline, BODY_MAX)] : [];
  return { title: text(`${TITLE[kind]}: ${item.title}`, TITLE_MAX), body: [...headline, text(bodyLine(kind, item, context.now), BODY_MAX), text(where, BODY_MAX)].join("\n") };
}

export interface NotifierDeps {
  readonly settings: () => NotificationSettings;
  readonly windowFocused: () => boolean;
  /** The open items (needs you, running, queued), or undefined when the engine does not answer. A finished item is not among them and is first seen quietly. */
  readonly board: () => Promise<readonly ItemRecord[] | undefined>;
  /** The engine's setup, or undefined when the engine does not answer. */
  readonly setup: () => Promise<Setup | undefined>;
  /** Shows a notification; `onClick` is called when the engineer clicks it. Returns whether it was shown. Must not throw. */
  readonly show: (note: Note, onClick: () => void) => boolean;
  /** Brings the window to the front and opens the item in it. */
  readonly open: (itemId: string) => void;
  /** Plays the sound of a kind now, from the set; Sound only and "player" banners use it. Must not throw. */
  readonly play: (kind: NoteKind, set: SoundSet) => void;
  /** The name of the bundled sound file for a kind, or undefined when none applies (not packaged, not macOS, or the macOS default set). */
  readonly bundledSound: (kind: NoteKind, set: SoundSet) => string | undefined;
  /** Whether a sound may disturb the user now. */
  readonly focus: () => Promise<FocusState>;
  /** Whether the hint line has been shown, and a way to record that it has. */
  readonly hint: { readonly shown: () => boolean; readonly markShown: () => void };
  /** How a banner gets its sound; defaults to `BANNER_SOUND`. */
  readonly bannerSound?: BannerSound;
  readonly now: () => number;
  readonly platform: NodeJS.Platform;
}

export interface Notifier {
  /** Learns the open items again; call it on every connect and reconnect. Updates that come meanwhile are replayed quietly after it. */
  resync(): Promise<void>;
  onEvent(event: BridgeEvent["event"]): void;
  /** The item the window shows now, or undefined. */
  setViewedItem(itemId: string | undefined): void;
  /** Shows one sample banner and plays the Needs you sound, the way a real event does, whatever the modes say. */
  sendTest(): Promise<void>;
}

/** The sample the test button shows. */
export const TEST_NOTE = { title: "Needs you: Test notification", body: "This is how a Tokama notification looks and sounds.\nSettings → Notifications" } as const;

export function createNotifier(deps: NotifierDeps): Notifier {
  const tracker = createTracker();
  let viewed: string | undefined;
  let syncing = false;
  let waiting: ItemRecord[] = [];
  // A newer resync makes an older one that is still waiting for the board stand down.
  let round = 0;

  const bannerSound = deps.bannerSound ?? BANNER_SOUND;

  // The app plays the sound itself unless Focus or a locked screen asks for quiet. Sound only and "player" banners share it.
  const playUnlessQuiet = async (kind: NoteKind, set: SoundSet) => {
    const focus = await deps.focus();
    const quiet = focus === "on" || focus === "locked" || (focus === "unknown" && !PLAY_WHEN_FOCUS_UNKNOWN);
    if (!quiet) deps.play(kind, set);
  };
  // One banner, with its sound when `withSound`. The hint line goes on the first banner only.
  const deliver = async (kind: NoteKind, text: Pick<Note, "title" | "body">, withSound: boolean, set: SoundSet, onClick: () => void, hinted: boolean) => {
    const sound = withSound && bannerSound === "bundled" ? deps.bundledSound(kind, set) : undefined;
    const shown = deps.show({ ...text, silent: !withSound || bannerSound === "player", ...(sound === undefined ? {} : { sound }) }, onClick);
    // The hint is used up only by a banner that appeared; the next one carries it otherwise.
    if (hinted && shown) deps.hint.markShown();
    if (withSound && bannerSound === "player") await playUnlessQuiet(kind, set);
  };
  const present = async (kind: NoteKind, item: ItemRecord, withSound: boolean, set: SoundSet) => {
    const setup = await deps.setup().catch(() => undefined);
    const text = noteText(kind, item, { ...(setup === undefined ? {} : { setup }), now: deps.now(), platform: deps.platform });
    const hinted = !deps.hint.shown();
    const body = hinted ? `${text.body}\n${plainText(HINT_LINE, BODY_MAX, deps.platform)}` : text.body;
    await deliver(kind, { title: text.title, body }, withSound, set, () => deps.open(item.id), hinted);
  };
  const handle = (item: ItemRecord, loud: boolean) => {
    const kind = tracker.observe(item, loud);
    if (kind === undefined) return;
    const settings = deps.settings();
    const mode = settings[kind];
    if (mode === "off" || isSuppressed(deps.windowFocused(), viewed, item.id)) return;
    const run = mode === "sound" ? playUnlessQuiet(kind, settings.sounds) : present(kind, item, mode === "both", settings.sounds);
    void run.catch(() => undefined);
  };

  return {
    async resync() {
      const mine = ++round;
      syncing = true;
      waiting = [];
      const items = await deps.board().catch(() => undefined);
      if (mine !== round) return;
      // Without the open items there is nothing to compare with: stay quiet rather than report what happened while away.
      if (items === undefined) tracker.reset();
      else tracker.seed(items);
      const replay = waiting;
      waiting = [];
      syncing = false;
      for (const item of replay) handle(item, false);
    },
    onEvent(event) {
      if (event.type !== "item_updated") return;
      if (syncing) waiting.push(event.item);
      else handle(event.item, true);
    },
    setViewedItem(itemId) {
      viewed = itemId;
    },
    sendTest: () => deliver("needsYou", TEST_NOTE, true, deps.settings().sounds, () => undefined, false),
  };
}
