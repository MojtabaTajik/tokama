import type { ItemRecord, Setup } from "@tokama/core";
import { describe, expect, it } from "vitest";
import type { NoteKind, NotificationSettings, SoundSet } from "../shared/desktop-state.js";
import { type BannerSound, createNotifier, createTracker, durationText, isSuppressed, type Note, type NotifierDeps, noteText, PLAY_WHEN_FOCUS_UNKNOWN, plainText } from "./notifier.js";
import type { FocusState } from "./sound/focus.js";

const MINUTE = 60_000;
const NOW = Date.UTC(2025, 9, 20, 15, 0, 0);

const item = (fields: Record<string, unknown> = {}): ItemRecord =>
  ({
    schemaVersion: 1,
    id: "item_1",
    kind: "task",
    templateId: "builtin/plan-and-build",
    title: "Add order export endpoint",
    text: "",
    repoIds: ["orders-api"],
    privacy: "local_only",
    state: "running",
    createdAt: NOW - 9 * MINUTE,
    steps: [],
    ...fields,
  }) as unknown as ItemRecord;

const decision = (id: string, question = "The plan is ready. Approve it to start Build.") => ({ id, stepIndex: 0, question, choices: [{ id: "approve", label: "Approve" }] });
const asking = (id = "d1", fields: Record<string, unknown> = {}) => item({ state: "needs_you", decision: decision(id), ...fields });
const done = (fields: Record<string, unknown> = {}) => item({ state: "done", outcome: { kind: "done" }, ...fields });
const failed = (fields: Record<string, unknown> = {}) => item({ state: "failed", ...fields });

describe("createTracker", () => {
  it("reports an item that enters needs you, ends done or ends failed after the seed", () => {
    const tracker = createTracker();
    tracker.seed([item(), item({ id: "item_2" }), item({ id: "item_3" })]);
    expect(tracker.observe(asking())).toBe("needsYou");
    expect(tracker.observe(done({ id: "item_2" }))).toBe("finished");
    expect(tracker.observe(failed({ id: "item_3" }))).toBe("failed");
  });

  it("does not report what the seed already held, or the same state again", () => {
    const tracker = createTracker();
    tracker.seed([asking("d1"), done({ id: "item_2" }), failed({ id: "item_3" })]);
    expect(tracker.observe(asking("d1", { cardLine: "still waiting" }))).toBeUndefined();
    expect(tracker.observe(done({ id: "item_2", finish: { worktreeRemoved: false, running: "merge" } }))).toBeUndefined();
    expect(tracker.observe(failed({ id: "item_3" }))).toBeUndefined();
    expect(tracker.observe(asking("d1"))).toBeUndefined();
  });

  it("reports nothing before the first seed, and records what it saw", () => {
    const tracker = createTracker();
    expect(tracker.observe(asking("d1"))).toBeUndefined();
    tracker.seed([]);
    expect(tracker.observe(asking("d2"))).toBeUndefined();
  });

  it("does not report an item it sees for the first time", () => {
    const tracker = createTracker();
    tracker.seed([]);
    expect(tracker.observe(done())).toBeUndefined();
    expect(tracker.observe(done())).toBeUndefined();
  });

  it("reports a new decision on the same item, and not the same decision twice", () => {
    const tracker = createTracker();
    tracker.seed([item()]);
    expect(tracker.observe(asking("d1"))).toBe("needsYou");
    expect(tracker.observe(asking("d1"))).toBeUndefined();
    expect(tracker.observe(item())).toBeUndefined();
    expect(tracker.observe(asking("d2"))).toBe("needsYou");
  });

  it("reports an item that ends again after it ran again", () => {
    const tracker = createTracker();
    tracker.seed([failed()]);
    expect(tracker.observe(item())).toBeUndefined();
    expect(tracker.observe(failed())).toBe("failed");
  });

  it("does not report a stopped or queued item, or a needs you item without a decision", () => {
    const tracker = createTracker();
    tracker.seed([item()]);
    expect(tracker.observe(item({ state: "queued" }))).toBeUndefined();
    expect(tracker.observe(item({ state: "stopped" }))).toBeUndefined();
    expect(tracker.observe(item({ state: "needs_you" }))).toBeUndefined();
  });

  it("a replay that is not loud only records", () => {
    const tracker = createTracker();
    tracker.seed([item()]);
    expect(tracker.observe(asking("d1"), false)).toBeUndefined();
    expect(tracker.observe(asking("d1"))).toBeUndefined();
  });

  it("a reset forgets everything and stays quiet until the next seed", () => {
    const tracker = createTracker();
    tracker.seed([item()]);
    tracker.reset();
    expect(tracker.observe(asking("d1"))).toBeUndefined();
    expect(tracker.observe(asking("d2"))).toBeUndefined();
    tracker.seed([]);
    tracker.observe(item());
    expect(tracker.observe(asking("d3"))).toBe("needsYou");
  });

  it("a second seed forgets the first: a reconnect repeats nothing", () => {
    const tracker = createTracker();
    tracker.seed([item()]);
    tracker.seed([asking("d1")]);
    expect(tracker.observe(asking("d1"))).toBeUndefined();
  });
});

describe("isSuppressed", () => {
  it("holds only when the window is in front and shows that item", () => {
    expect(isSuppressed(true, "item_1", "item_1")).toBe(true);
    expect(isSuppressed(false, "item_1", "item_1")).toBe(false);
    expect(isSuppressed(true, "item_2", "item_1")).toBe(false);
    expect(isSuppressed(true, undefined, "item_1")).toBe(false);
  });
});

describe("plainText", () => {
  it("makes one line without control or invisible formatting characters", () => {
    expect(plainText("a\nb\t\u0007c‮d  e", 100, "darwin")).toBe("a b c d e");
  });

  it("cuts a long text with an ellipsis", () => {
    expect(plainText("x".repeat(30), 10, "darwin")).toBe(`${"x".repeat(9)}…`);
  });

  it("escapes markup on Linux only", () => {
    expect(plainText("a <b>x</b> & y", 100, "linux")).toBe("a &lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(plainText("a <b>x</b> & y", 100, "darwin")).toBe("a <b>x</b> & y");
  });
});

describe("durationText", () => {
  it("says minutes, hours and under a minute", () => {
    expect([0, 20_000, 9 * MINUTE, 59 * MINUTE, 60 * MINUTE, 65 * MINUTE, 120 * MINUTE, -5].map(durationText)).toEqual(["under 1 min", "under 1 min", "9 min", "59 min", "1 h", "1 h 5 min", "2 h", "under 1 min"]);
  });
});

const setup = { templates: [{ id: "builtin/plan-and-build", name: "Plan and build" }] } as unknown as Setup;
const context = { setup, now: NOW, platform: "darwin" as const };

describe("noteText", () => {
  it("names a decision with its question, and the template and repo", () => {
    expect(noteText("needsYou", asking(), context)).toEqual({ title: "Needs you: Add order export endpoint", body: "The plan is ready. Approve it to start Build.\nPlan and build · orders-api" });
  });

  it("says how long a finished item took, and what can be done with it", () => {
    const merged = done({ outcome: { kind: "done", commits: [{ repoId: "orders-api", commit: "a".repeat(40) }] }, finish: { worktreeRemoved: false } });
    expect(noteText("finished", merged, context)).toEqual({ title: "Finished: Add order export endpoint", body: "Done in 9 min. Ready to merge or open a PR.\nPlan and build · orders-api" });
    expect(noteText("finished", done({ outcome: { kind: "no_action_needed", detail: "Nothing to change." } }), context).body).toBe("Done in 9 min. Nothing to change.\nPlan and build · orders-api");
    expect(noteText("finished", done(), context).body).toBe("Done in 9 min.\nPlan and build · orders-api");
  });

  it("names the failing step, its runs and its failing check", () => {
    const build = { name: "Build", stage: "working", state: "failed", data: "none", runs: 3, attempts: [{ attempt: 3, result: "failed", checks: [{ command: "pnpm test", passed: false, exitCode: 1 }] }] };
    expect(noteText("failed", failed({ steps: [{ name: "Plan", state: "passed" }, build] }), context).body).toBe("Build failed 3 times: pnpm test\nPlan and build · orders-api");
    expect(noteText("failed", failed({ steps: [{ name: "Build", state: "failed", detail: "the agent crashed" }] }), context).body).toBe("Build failed: the agent crashed\nPlan and build · orders-api");
    expect(noteText("failed", failed({ steps: [{ name: "Build", state: "failed" }] }), context).body).toBe("Build failed.\nPlan and build · orders-api");
    expect(noteText("failed", failed({ outcome: { kind: "failed", detail: "The engine stopped." } }), context).body).toBe("The engine stopped.\nPlan and build · orders-api");
    expect(noteText("failed", failed(), context).body).toBe("A step failed.\nPlan and build · orders-api");
  });

  it("falls back to the template id without a setup, and leaves out the repos when there are none", () => {
    expect(noteText("needsYou", asking("d1", { repoIds: [], templateId: "builtin/other" }), { now: NOW, platform: "darwin" }).body).toBe("The plan is ready. Approve it to start Build.\nbuiltin/other");
    expect(noteText("needsYou", asking("d1", { repoIds: ["a", "b"] }), context).body).toMatch(/\nPlan and build · a, b$/);
  });

  it("escapes every part on Linux, and keeps a long title short", () => {
    const note = noteText("needsYou", asking("d1", { title: "Fix <img> & more", repoIds: ["a&b"] }), { ...context, platform: "linux" });
    expect(note.title).toBe("Needs you: Fix &lt;img&gt; &amp; more");
    expect(note.body).toBe("The plan is ready. Approve it to start Build.\nPlan and build · a&amp;b");
    expect(noteText("needsYou", asking("d1", { title: "t".repeat(200) }), context).title.length).toBeLessThanOrEqual(100);
  });
});

interface SetupOptions {
  settings?: Partial<NotificationSettings>;
  focused?: boolean;
  board?: ItemRecord[] | undefined | Promise<ItemRecord[]>;
  setup?: Setup | undefined | Error;
  show?: () => void;
  /** What `show` reports: false when the system did not show the banner. */
  bannerShown?: boolean;
  focus?: FocusState;
  bannerSound?: BannerSound;
  /** The hint counts as shown unless a test asks for it to be new. */
  hintShown?: boolean;
  packagedMac?: boolean;
}

/** A name like the one the app gives a bundled sound, for a packaged Mac with the Tokama sounds. */
const bundled = (kind: NoteKind, set: SoundSet): string | undefined => (set === "tokama" ? `tokama-${kind}.wav` : undefined);

function setupNotifier(options: SetupOptions = {}) {
  const shown: { note: Note; click: () => void }[] = [];
  const opened: string[] = [];
  const played: [NoteKind, SoundSet][] = [];
  const hint = { value: options.hintShown ?? true, marked: 0 };
  const deps: NotifierDeps = {
    settings: () => ({ needsYou: "banner", finished: "banner", failed: "banner", sounds: "tokama", ...options.settings }),
    windowFocused: () => options.focused ?? false,
    play: (kind, set) => played.push([kind, set]),
    bundledSound: (kind, set) => (options.packagedMac === false ? undefined : bundled(kind, set)),
    focus: async () => options.focus ?? "unknown",
    hint: {
      shown: () => hint.value,
      markShown: () => {
        hint.value = true;
        hint.marked += 1;
      },
    },
    ...(options.bannerSound === undefined ? {} : { bannerSound: options.bannerSound }),
    board: async () => ("board" in options ? options.board : [item(), item({ id: "item_2" })]), // open items only
    setup: async () => {
      if (options.setup instanceof Error) throw options.setup;
      return "setup" in options ? options.setup : setup;
    },
    show: (note, click) => {
      options.show?.();
      shown.push({ note, click });
      return options.bannerShown ?? true;
    },
    open: (itemId) => opened.push(itemId),
    now: () => NOW,
    platform: "darwin",
  };
  return { notifier: createNotifier(deps), shown, opened, played, hint };
}
const event = (record: ItemRecord) => ({ type: "item_updated" as const, item: record });
const settle = () => new Promise((done) => setTimeout(done, 0));

/** The three kinds of transition, as the item that causes each. */
const CAUSE: Record<NoteKind, () => ItemRecord> = { needsYou: () => asking(), finished: () => done(), failed: () => failed() };

/** Sends the transition of `kind` through a notifier set up with `options`. */
async function transition(kind: NoteKind, options: SetupOptions) {
  const run = setupNotifier(options);
  await run.notifier.resync();
  run.notifier.onEvent(event(CAUSE[kind]()));
  await settle();
  return run;
}

describe("createNotifier", () => {
  it("shows one notification per transition and a click opens that item", async () => {
    const { notifier, shown, opened } = setupNotifier();
    await notifier.resync();
    notifier.onEvent(event(asking()));
    notifier.onEvent(event(done({ id: "item_2" })));
    await settle();
    expect(shown.map(({ note }) => note.title)).toEqual(["Needs you: Add order export endpoint", "Finished: Add order export endpoint"]);
    shown[1]!.click();
    expect(opened).toEqual(["item_2"]);
  });

  describe.each(["needsYou", "finished", "failed"] as const)("a %s transition", (kind) => {
    it("Banner + sound shows a banner that is not silent and names the bundled sound, and plays nothing itself", async () => {
      const { shown, played } = await transition(kind, { settings: { [kind]: "both" } });
      expect(shown.map(({ note }) => [note.silent, note.sound])).toEqual([[false, `tokama-${kind}.wav`]]);
      expect(played).toEqual([]);
    });

    it("Banner only shows a silent banner without a sound name", async () => {
      const { shown, played } = await transition(kind, { settings: { [kind]: "banner" } });
      expect(shown.map(({ note }) => [note.silent, note.sound])).toEqual([[true, undefined]]);
      expect(played).toEqual([]);
    });

    it("Sound only shows no banner and plays the sound of the kind from the set", async () => {
      const { shown, played } = await transition(kind, { settings: { [kind]: "sound", sounds: "macos" } });
      expect(shown).toEqual([]);
      expect(played).toEqual([[kind, "macos"]]);
    });

    it("Off shows and plays nothing", async () => {
      const { shown, played } = await transition(kind, { settings: { [kind]: "off" } });
      expect([shown, played]).toEqual([[], []]);
    });
  });

  it("Banner + sound with the macOS default set, or where no bundled sound applies, leaves the sound to the system", async () => {
    for (const options of [{ settings: { needsYou: "both", sounds: "macos" } }, { settings: { needsYou: "both" }, packagedMac: false }] as const) {
      const { shown } = await transition("needsYou", options);
      expect(shown.map(({ note }) => [note.silent, note.sound])).toEqual([[false, undefined]]);
    }
  });

  it("with the player switch, Banner + sound shows a silent banner and the app plays the sound; Banner only plays nothing", async () => {
    const both = await transition("failed", { settings: { failed: "both" }, bannerSound: "player" });
    expect(both.shown.map(({ note }) => [note.silent, note.sound])).toEqual([[true, undefined]]);
    expect(both.played).toEqual([["failed", "tokama"]]);
    const banner = await transition("failed", { settings: { failed: "banner" }, bannerSound: "player" });
    expect(banner.played).toEqual([]);
  });

  it("Sound only is quiet while the screen is locked or Focus is on, and plays when Focus is off", async () => {
    for (const [focus, plays] of [["locked", 0], ["on", 0], ["off", 1], ["unknown", PLAY_WHEN_FOCUS_UNKNOWN ? 1 : 0]] as const) {
      const { played } = await transition("finished", { settings: { finished: "sound" }, focus });
      expect(played).toHaveLength(plays);
    }
  });

  it("the focus check does not apply to banners", async () => {
    const { shown } = await transition("needsYou", { settings: { needsYou: "both" }, focus: "locked" });
    expect(shown).toHaveLength(1);
  });

  it("Sound only is also stopped by the item the focused window shows", async () => {
    const { notifier, played } = setupNotifier({ settings: { needsYou: "sound" }, focused: true });
    await notifier.resync();
    notifier.setViewedItem("item_1");
    notifier.onEvent(event(asking()));
    await settle();
    expect(played).toEqual([]);
  });

  describe("the hint line", () => {
    it("goes on the first banner only, and is marked shown once", async () => {
      const run = setupNotifier({ hintShown: false });
      await run.notifier.resync();
      run.notifier.onEvent(event(asking()));
      run.notifier.onEvent(event(done({ id: "item_2" })));
      await settle();
      expect(run.shown[0]?.note.body).toBe("The plan is ready. Approve it to start Build.\nPlan and build · orders-api\nChange how Tokama notifies you in Settings → Notifications");
      expect(run.shown[1]?.note.body).not.toContain("Settings");
      expect(run.hint.marked).toBe(1);
    });

    it("is not used up by a Sound only event, so the next banner carries it", async () => {
      const run = setupNotifier({ hintShown: false, settings: { needsYou: "sound" } });
      await run.notifier.resync();
      run.notifier.onEvent(event(asking()));
      await settle();
      expect(run.hint.marked).toBe(0);
      run.notifier.onEvent(event(done({ id: "item_2" })));
      await settle();
      expect(run.shown[0]?.note.body).toContain("Settings → Notifications");
      expect(run.hint.marked).toBe(1);
    });

    it("is not used up by a banner that did not show, so the next banner carries it", async () => {
      const failedShow = await transition("needsYou", { hintShown: false, bannerShown: false });
      expect(failedShow.hint.marked).toBe(0);
      expect(failedShow.shown[0]?.note.body).toContain("Settings → Notifications");
      const throwing = setupNotifier({ hintShown: false, show: () => { throw new Error("no service"); } });
      await throwing.notifier.resync();
      throwing.notifier.onEvent(event(asking()));
      await settle();
      expect(throwing.hint.marked).toBe(0);
    });

    it("is not added when it was shown already", async () => {
      const { shown, hint } = await transition("needsYou", { hintShown: true });
      expect(shown[0]?.note.body).not.toContain("Settings");
      expect(hint.marked).toBe(0);
    });
  });

  it("shows nothing for an update that is not an item update", async () => {
    const { notifier, shown } = setupNotifier();
    await notifier.resync();
    notifier.onEvent({ type: "usage_changed" });
    notifier.onEvent({ type: "setup_changed" });
    await settle();
    expect(shown).toEqual([]);
  });

  it("follows the modes, and a transition that was off never shows later", async () => {
    const settings: { -readonly [K in keyof NotificationSettings]?: NotificationSettings[K] } = { needsYou: "off" };
    const { notifier, shown } = setupNotifier({ settings });
    await notifier.resync();
    notifier.onEvent(event(asking()));
    settings.needsYou = "banner";
    notifier.onEvent(event(asking()));
    await settle();
    expect(shown).toEqual([]);
  });

  it("shows nothing for the item the focused window shows, and does when the window is not in front or shows another", async () => {
    for (const [focused, viewed, count] of [[true, "item_1", 0], [false, "item_1", 1], [true, "item_2", 1], [true, undefined, 1]] as const) {
      const { notifier, shown } = setupNotifier({ focused });
      await notifier.resync();
      notifier.setViewedItem(viewed);
      notifier.onEvent(event(asking()));
      await settle();
      expect(shown).toHaveLength(count);
    }
  });

  it("stays quiet about a finished item that was not among the open items", async () => {
    const seed = [item({ id: "item_open" })];
    const { notifier, shown } = setupNotifier({ board: seed });
    await notifier.resync();
    // Finished before the seed, so it is not on the board: its updates only record it.
    notifier.onEvent(event(done({ id: "item_old" })));
    notifier.onEvent(event(done({ id: "item_old", outcome: { kind: "done", commits: [] } })));
    await settle();
    expect(shown).toEqual([]);
    // An open item that finishes is news.
    notifier.onEvent(event(done({ id: "item_open" })));
    await settle();
    expect(shown.map(({ note }) => note.title)).toEqual(["Finished: Add order export endpoint"]);
    // An item that started after the seed is first seen as running, and its end is news.
    notifier.onEvent(event(item({ id: "item_new" })));
    notifier.onEvent(event(done({ id: "item_new" })));
    await settle();
    expect(shown).toHaveLength(2);
  });

  it("does not repeat anything after a resync, and shows a new decision", async () => {
    const waiting = asking("d1");
    const { notifier, shown } = setupNotifier({ board: [waiting, done({ id: "item_2" })] });
    await notifier.resync();
    notifier.onEvent(event(waiting));
    notifier.onEvent(event(done({ id: "item_2" })));
    await notifier.resync();
    notifier.onEvent(event(waiting));
    await settle();
    expect(shown).toEqual([]);
    notifier.onEvent(event(asking("d2")));
    await settle();
    expect(shown).toHaveLength(1);
  });

  it("replays updates that came while the board loaded, without notifying", async () => {
    let release: (items: ItemRecord[]) => void = () => undefined;
    const { notifier, shown } = setupNotifier({ board: new Promise((resolve) => (release = resolve)) });
    const syncing = notifier.resync();
    notifier.onEvent(event(asking("d1")));
    release([item()]);
    await syncing;
    notifier.onEvent(event(asking("d1")));
    await settle();
    expect(shown).toEqual([]);
  });

  it("a board that fails on a reconnect leaves the next update quiet", async () => {
    let board: ItemRecord[] | undefined = [item()];
    const shown: Note[] = [];
    const notifier = createNotifier({ settings: () => ({ needsYou: "banner", finished: "banner", failed: "banner", sounds: "tokama" }), windowFocused: () => false, board: async () => board, setup: async () => setup, show: (note) => (shown.push(note), true), open: () => undefined, play: () => undefined, bundledSound: () => undefined, focus: async () => "unknown", hint: { shown: () => true, markShown: () => undefined }, now: () => NOW, platform: "darwin" });
    await notifier.resync();
    board = undefined;
    await notifier.resync();
    notifier.onEvent(event(asking()));
    await settle();
    expect(shown).toEqual([]);
  });

  it("shows nothing when the board never loaded, and a failed setup only costs the template name", async () => {
    const none = setupNotifier({ board: undefined });
    await none.notifier.resync();
    none.notifier.onEvent(event(asking()));
    await settle();
    expect(none.shown).toEqual([]);
    const noSetup = setupNotifier({ setup: undefined });
    await noSetup.notifier.resync();
    noSetup.notifier.onEvent(event(asking()));
    await settle();
    expect(noSetup.shown[0]?.note.body).toBe("The plan is ready. Approve it to start Build.\nbuiltin/plan-and-build · orders-api");
  });

  it("an error while showing the note or reading the setup never escapes", async () => {
    const showing = setupNotifier({ show: () => { throw new Error("no service"); } });
    await showing.notifier.resync();
    showing.notifier.onEvent(event(asking()));
    const reading = setupNotifier({ setup: new Error("no engine") });
    await reading.notifier.resync();
    reading.notifier.onEvent(event(asking()));
    await settle();
    expect(reading.shown).toHaveLength(1);
  });
});
