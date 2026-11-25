// Desktop notifications about items: when one needs the engineer, finishes or fails. The main
// process hears every item update from the engine and tells the system. No Electron here: the
// system's notification, the window and the clock come in through `NotifierDeps`, so it is tested
// with fakes. Text is plain: control characters are removed, and on Linux, where a notification
// server may read markup, `&`, `<` and `>` are escaped.
import { CUT_MARK, cutText, finishActions, type ItemRecord, type Setup } from "@tokama/core";
import type { BridgeEvent } from "../shared/bridge.js";
import type { NotificationSettings } from "../shared/desktop-state.js";

export type NoteKind = keyof Pick<NotificationSettings, "needsYou" | "finished" | "failed">;

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
 * Which transitions of an item are news. It is seeded from the board, and after that an update
 * is a transition only when it differs from what was seen: a new decision id, or an end state
 * reached now. An item seen for the first time is only recorded, and so is everything before the
 * first seed, so a restart, a reconnect or a refetch never repeats a notification.
 */
export function createTracker() {
  const seen = new Map<string, Seen>();
  let seeded = false;
  return {
    /** Replaces what is known with the board's items; none of them is news. */
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
  const cut = short === line ? line : `${short.slice(0, -CUT_MARK.length).trimEnd()}${CUT_MARK}`;
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

/** The failing step and its check, e.g. "Build failed 3 times: pnpm test". */
function failureLine(item: ItemRecord): string {
  const step = item.steps.find((candidate) => candidate.state === "failed");
  if (step === undefined) return item.outcome?.detail ?? "A step failed.";
  const check = step.attempts?.at(-1)?.checks.find((candidate) => !candidate.passed)?.command;
  const times = step.runs !== undefined && step.runs > 1 ? ` ${step.runs} times` : "";
  const why = check ?? step.detail;
  return `${step.name} failed${times}${why === undefined ? "." : `: ${why}`}`;
}

function bodyLine(kind: NoteKind, item: ItemRecord, now: number): string {
  if (kind === "needsYou") return item.decision?.question ?? "Waiting for your decision.";
  if (kind === "failed") return failureLine(item);
  const next = finishActions(item).includes("merge") ? " Ready to merge or open a PR." : item.outcome?.detail === undefined ? "" : ` ${item.outcome.detail}`;
  return `Done in ${durationText(now - item.createdAt)}.${next}`;
}

export interface Note {
  readonly title: string;
  /** The line about the item, then the template and the repos. */
  readonly body: string;
  readonly silent: boolean;
}

/** The notification for a transition of `item`. `setup` names the template; without it the template's id stands in. */
export function noteText(kind: NoteKind, item: ItemRecord, context: { readonly setup?: Pick<Setup, "templates">; readonly now: number; readonly platform: NodeJS.Platform }): Omit<Note, "silent"> {
  const template = context.setup?.templates.find((candidate) => candidate.id === item.templateId)?.name ?? item.templateId;
  const where = [template, ...(item.repoIds.length === 0 ? [] : [item.repoIds.join(", ")])].join(" · ");
  const text = (value: string, max: number) => plainText(value, max, context.platform);
  return { title: text(`${TITLE[kind]}: ${item.title}`, TITLE_MAX), body: `${text(bodyLine(kind, item, context.now), BODY_MAX)}\n${text(where, BODY_MAX)}` };
}

export interface NotifierDeps {
  readonly settings: () => NotificationSettings;
  readonly windowFocused: () => boolean;
  /** Every item on the board, or undefined when the engine does not answer. */
  readonly board: () => Promise<readonly ItemRecord[] | undefined>;
  /** The engine's setup, or undefined when the engine does not answer. */
  readonly setup: () => Promise<Setup | undefined>;
  /** Shows a notification; `onClick` is called when the engineer clicks it. Must not throw. */
  readonly show: (note: Note, onClick: () => void) => void;
  /** Brings the window to the front and opens the item in it. */
  readonly open: (itemId: string) => void;
  readonly now: () => number;
  readonly platform: NodeJS.Platform;
}

export interface Notifier {
  /** Learns the board again; call it on every connect and reconnect. Updates that come meanwhile are replayed quietly after it. */
  resync(): Promise<void>;
  onEvent(event: BridgeEvent["event"]): void;
  /** The item the window shows now, or undefined. */
  setViewedItem(itemId: string | undefined): void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const tracker = createTracker();
  let viewed: string | undefined;
  let syncing = false;
  let waiting: ItemRecord[] = [];
  // A newer resync makes an older one that is still waiting for the board stand down.
  let round = 0;

  const present = async (kind: NoteKind, item: ItemRecord, silent: boolean) => {
    const setup = await deps.setup().catch(() => undefined);
    const text = noteText(kind, item, { ...(setup === undefined ? {} : { setup }), now: deps.now(), platform: deps.platform });
    deps.show({ ...text, silent }, () => deps.open(item.id));
  };
  const handle = (item: ItemRecord, loud: boolean) => {
    const kind = tracker.observe(item, loud);
    if (kind === undefined) return;
    const settings = deps.settings();
    if (!settings[kind] || isSuppressed(deps.windowFocused(), viewed, item.id)) return;
    void present(kind, item, !settings.sound).catch(() => undefined);
  };

  return {
    async resync() {
      const mine = ++round;
      syncing = true;
      waiting = [];
      const items = await deps.board().catch(() => undefined);
      if (mine !== round) return;
      // Without the board there is nothing to compare with: stay quiet rather than report what happened while away.
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
  };
}
