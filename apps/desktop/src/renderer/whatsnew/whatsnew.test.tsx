// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokamaBridge, WhatsNewInfo } from "../../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE } from "../../shared/desktop-state.js";
import { type Note, SECURITY_LINE } from "../../shared/whats-new.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
import { NOW } from "../testing/sample.js";
import { Chip } from "../ui/Chip.js";
import { CHIP_MS, UpdatedChip } from "./UpdatedChip.js";
import { WhatsNewHistory } from "./WhatsNewHistory.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

const VERSION = "1.2.3";
const note = (overrides: Partial<Note> = {}): Note => ({
  version: VERSION,
  date: "2026-12-03",
  security: false,
  highlights: [
    { title: "Sounds for notifications", text: "A soft gecko chirp when work needs you.", where: "Pick it in Settings → Notifications" },
    { title: "See what a run changed", text: "The Diff tab shows the exact commit." },
  ],
  fixes: 12,
  ...overrides,
});
const OLDER = note({ version: "1.2.0", date: "2026-11-20", highlights: [], fixes: 2 });
const SECURITY_NOTE = note({ version: "1.0.0", date: "2026-11-01", security: true, highlights: [], fixes: 0 });
const cardDue = (n: Note = note()): WhatsNewInfo => ({ appVersion: VERSION, notes: [n, OLDER], due: { card: n.version } });
const chipDue = (n: Note, kind: "fixes" | "security"): WhatsNewInfo => ({ appVersion: n.version, notes: [n], due: { chip: { version: n.version, kind } } });

const render = async (bridge: TokamaBridge, initial = DEFAULT_DESKTOP_STATE) => {
  await act(async () => root.render(<App bridge={bridge} retryDelayMs={10} now={NOW} initial={initial} />));
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const button = (label: string) => $$("button").find((candidate) => candidate.textContent === label) ?? null;
const card = () => $('aside [role="region"]');
const chip = () => $("aside .chip");
const aboutOpen = () => $('main[aria-label="About"]') !== null;
const COLLAPSED = { ...DEFAULT_DESKTOP_STATE, sidebar: { width: 264, collapsed: true } };

describe("the What's new card", () => {
  it("sits at the foot of the sidebar with the highlights, where to find them and the fixes line, as text", async () => {
    await render(fakeBridge(CONNECTED, { whatsNew: cardDue() }).bridge);
    const region = card();
    expect(region?.getAttribute("aria-labelledby")).toBe(region?.querySelector("h3")?.id);
    expect(region?.querySelector("h3")?.textContent).toBe("What's new in Tokama");
    expect(region?.querySelector(".wn-eyebrow")?.textContent).toBe("Updated · 1.2.3");
    expect([...(region?.querySelectorAll(".wn-highlight-title") ?? [])].map((el) => el.textContent)).toEqual(["Sounds for notifications", "See what a run changed"]);
    expect(region?.querySelector(".wn-highlight-where")?.textContent).toBe("Pick it in Settings → Notifications");
    expect(region?.querySelector(".wn-fixes")?.textContent).toBe("+ 12 smaller fixes");
    expect(region?.querySelector(".wn-security")).toBeNull();
    expect([...(region?.querySelectorAll("button") ?? [])].map((el) => el.textContent)).toEqual(["See all", "Got it"]);
    // Last in the sidebar, so Tab reaches it after the rest, and inside a polite live region.
    expect(region?.closest(".sb-foot")?.getAttribute("aria-live")).toBe("polite");
    expect($("aside")?.lastElementChild).toBe(region?.closest(".sb-foot"));
  });

  it("shows note text literally: markup in a sentence never becomes an element, and nothing links", async () => {
    const hostile = note({ highlights: [{ title: "<img src=x onerror=alert(1)>", text: "<b>bold</b> and <a href='https://evil.example'>link</a>", where: "<script>alert(1)</script>" }] });
    await render(fakeBridge(CONNECTED, { whatsNew: cardDue(hostile) }).bridge);
    expect(text(".wn-highlight-text")).toBe("<b>bold</b> and <a href='https://evil.example'>link</a>");
    expect(text(".wn-highlight-title")).toBe("<img src=x onerror=alert(1)>");
    expect(card()?.querySelector("b, a, img, script")).toBeNull();
  });

  it("names a security fix first, with the shield and the word", async () => {
    await render(fakeBridge(CONNECTED, { whatsNew: cardDue(note({ security: true })) }).bridge);
    const line = card()?.querySelector(".wn-security");
    expect(line?.textContent).toBe(`Security · ${SECURITY_LINE}`);
    expect(line?.querySelector("svg")).not.toBeNull();
    expect(card()?.querySelector(".wn-card-body")?.firstElementChild).toBe(line);
  });

  it("Got it closes it for good: the main process is told once, and it is gone", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: cardDue() });
    await render(fake.bridge);
    await click(button("Got it"));
    expect(fake.closeWhatsNew).toHaveBeenCalledOnce();
    expect(fake.closeWhatsNew).toHaveBeenCalledWith(VERSION, "card");
    expect(card()).toBeNull();
  });

  it("Escape inside the card does the same, and no other Escape handler hears it", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: cardDue() });
    await render(fake.bridge);
    const others = vi.fn();
    document.addEventListener("keydown", others);
    try {
      await act(async () => button("Got it")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    } finally {
      document.removeEventListener("keydown", others);
    }
    expect(others).not.toHaveBeenCalled();
    expect(fake.closeWhatsNew).toHaveBeenCalledWith(VERSION, "card");
    expect(card()).toBeNull();
  });

  it("Escape outside the card leaves it open", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: cardDue() });
    await render(fake.bridge);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(card()).not.toBeNull();
    expect(fake.closeWhatsNew).not.toHaveBeenCalled();
  });

  it("See all closes it and opens About with that version's row open", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: cardDue() });
    await render(fake.bridge);
    await click(button("See all"));
    expect(fake.closeWhatsNew).toHaveBeenCalledWith(VERSION, "card");
    expect(card()).toBeNull();
    expect(aboutOpen()).toBe(true);
    expect($$(".wn-head").map((head) => [head.textContent, head.getAttribute("aria-expanded")])).toEqual([
      ["▾1.2.3" + "2 highlightsthis version2026-12-03", "true"],
      ["▸1.2.0Fixes2026-11-20", "false"],
    ]);
    expect(text(".wn-body")).toContain("A soft gecko chirp when work needs you.");
    expect(document.activeElement?.id).toBe("about-whats-new");
  });

  it("About opened by hand later starts with every row closed", async () => {
    await render(fakeBridge(CONNECTED, { whatsNew: cardDue() }).bridge);
    await click(button("See all"));
    await click($('button[aria-label="About Tokama"]'));
    expect(aboutOpen()).toBe(false);
    await click($('button[aria-label="About Tokama"]'));
    expect(aboutOpen()).toBe(true);
    expect($$(".wn-head").map((head) => head.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  });

  it("waits while the sidebar is closed: no card, nothing marked, and it shows when the sidebar opens", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: cardDue() });
    await render(fake.bridge, COLLAPSED);
    expect(card()).toBeNull();
    expect(fake.closeWhatsNew).not.toHaveBeenCalled();
    await click($('button[aria-label="Sidebar"]'));
    expect(card()).not.toBeNull();
    expect(fake.closeWhatsNew).not.toHaveBeenCalled();
  });

  it("shows nothing when there is nothing due, or when the notes cannot be read", async () => {
    await render(fakeBridge(CONNECTED, { whatsNew: { appVersion: VERSION, notes: [note()] } }).bridge);
    expect([card(), chip()]).toEqual([null, null]);
    await render(fakeBridge(CONNECTED, { whatsNew: async () => Promise.reject(new Error("no")) }).bridge);
    expect([card(), chip()]).toEqual([null, null]);
  });

  it("shows no card for a due version whose note is not among the notes", async () => {
    await render(fakeBridge(CONNECTED, { whatsNew: { appVersion: VERSION, notes: [OLDER], due: { card: VERSION } } }).bridge);
    expect(card()).toBeNull();
  });
});

describe("the Updated to chip", () => {
  it("says Updated to <version> · fixes, and tells the main process once, as it first shows", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: chipDue(note({ highlights: [], fixes: 4 }), "fixes") });
    await render(fake.bridge);
    expect(chip()?.textContent).toBe("Updated to 1.2.3 · fixes");
    expect(chip()?.querySelector(".mono")?.textContent).toBe(VERSION);
    expect(chip()?.querySelector("svg")).not.toBeNull();
    expect(chip()?.closest(".sb-foot")?.getAttribute("aria-live")).toBe("polite");
    expect(card()).toBeNull();
    expect(fake.closeWhatsNew).toHaveBeenCalledOnce();
    expect(fake.closeWhatsNew).toHaveBeenCalledWith(VERSION, "chip");
  });

  it("says Security for a security release, with the reason as its title", async () => {
    await render(fakeBridge(CONNECTED, { whatsNew: chipDue(SECURITY_NOTE, "security") }).bridge);
    expect(chip()?.textContent).toBe("Updated to 1.0.0 · Security");
    expect(chip()?.getAttribute("title")).toBe(SECURITY_LINE);
  });

  it("goes after six seconds, and the main process was told once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeBridge(CONNECTED, { whatsNew: chipDue(note({ highlights: [], fixes: 4 }), "fixes") });
    await render(fake.bridge);
    expect(chip()).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(CHIP_MS - 1));
    expect(chip()).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(chip()).toBeNull();
    expect(fake.closeWhatsNew).toHaveBeenCalledOnce();
  });

  it("opens About on that version when clicked, and is gone", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: chipDue(note({ highlights: [], fixes: 4 }), "fixes") });
    await render(fake.bridge);
    await click(chip());
    expect(aboutOpen()).toBe(true);
    expect(chip()).toBeNull();
    expect($$(".wn-head").map((head) => head.getAttribute("aria-expanded"))).toEqual(["true"]);
  });

  it("waits while the sidebar is closed: nothing is marked as seen until it shows", async () => {
    const fake = fakeBridge(CONNECTED, { whatsNew: chipDue(note({ highlights: [], fixes: 4 }), "fixes") });
    await render(fake.bridge, COLLAPSED);
    expect(chip()).toBeNull();
    expect(fake.closeWhatsNew).not.toHaveBeenCalled();
    await click($('button[aria-label="Sidebar"]'));
    expect(chip()).not.toBeNull();
    expect(fake.closeWhatsNew).toHaveBeenCalledWith(VERSION, "chip");
  });

  it("is over for this run when the sidebar closes while it shows", async () => {
    await render(fakeBridge(CONNECTED, { whatsNew: chipDue(note({ highlights: [], fixes: 4 }), "fixes") }).bridge);
    await click($('button[aria-label="Sidebar"]'));
    await click($('button[aria-label="Sidebar"]'));
    expect(chip()).toBeNull();
  });

  it("tells it is shown, ends after its own time, and opens the notes when clicked", async () => {
    vi.useFakeTimers();
    const [onShown, onGone, onOpen] = [vi.fn(), vi.fn(), vi.fn()];
    await act(async () => root.render(<UpdatedChip version="0.2.1" kind="fixes" onShown={onShown} onGone={onGone} onOpen={onOpen} ms={50} />));
    expect([onShown.mock.calls.length, onGone.mock.calls.length]).toEqual([1, 0]);
    await act(async () => vi.advanceTimersByTime(50));
    expect(onGone).toHaveBeenCalledOnce();
    await click($("button"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("Chip", () => {
  it("is a button with its icon hidden from screen readers, its tone and its accessible name", async () => {
    const onClick = vi.fn();
    await act(async () => root.render(<Chip icon={<svg />} tone="attention" label="Important update" title="Details" onClick={onClick}>Update</Chip>));
    const chipButton = $("button.chip");
    expect(chipButton?.getAttribute("data-tone")).toBe("attention");
    expect(chipButton?.getAttribute("aria-label")).toBe("Important update");
    expect(chipButton?.getAttribute("title")).toBe("Details");
    expect(chipButton?.querySelector(".chip-icon")?.getAttribute("aria-hidden")).toBe("true");
    await click(chipButton);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("About's What's new", () => {
  const history = (info: WhatsNewInfo | "failed" | undefined, openVersion?: string) =>
    act(async () => root.render(<WhatsNewHistory info={info} openVersion={openVersion} siteUrl="https://tokama.dev" />));
  const info: WhatsNewInfo = { appVersion: VERSION, notes: [note(), OLDER, SECURITY_NOTE] };

  it("lists each release with its kind word, this version and its date, newest first, all closed", async () => {
    await history(info);
    expect(text(".wn-count")).toBe("3");
    expect($$(".wn-head").map((head) => head.textContent)).toEqual(["▸1.2.32 highlightsthis version2026-12-03", "▸1.2.0Fixes2026-11-20", "▸1.0.0Security2026-11-01"]);
    expect($$(".wn-head").map((head) => head.getAttribute("aria-expanded"))).toEqual(["false", "false", "false"]);
    expect($$(".wn-body")).toHaveLength(0);
  });

  it("counts one highlight in the singular", async () => {
    await history({ appVersion: VERSION, notes: [note({ highlights: [{ title: "T", text: "S." }] })] });
    expect(text(".wn-role")).toBe("1 highlight");
  });

  it("opens and closes each row on its own click, with aria-expanded", async () => {
    await history(info);
    await click($$(".wn-head")[1] ?? null);
    expect($$(".wn-head").map((head) => head.getAttribute("aria-expanded"))).toEqual(["false", "true", "false"]);
    expect(text(".wn-body")).toBe("+ 2 smaller fixes");
    await click($$(".wn-head")[2] ?? null);
    expect($$(".wn-body").map((body) => body.textContent)).toEqual(["+ 2 smaller fixes", `Security · ${SECURITY_LINE}`]);
    await click($$(".wn-head")[1] ?? null);
    expect($$(".wn-head").map((head) => head.getAttribute("aria-expanded"))).toEqual(["false", "false", "true"]);
  });

  it("starts with the asked row open and the heading focused", async () => {
    await history(info, "1.0.0");
    expect($$(".wn-head").map((head) => head.getAttribute("aria-expanded"))).toEqual(["false", "false", "true"]);
    expect(document.activeElement?.id).toBe("about-whats-new");
  });

  it("links to the product site only, and opens no other link", async () => {
    await history(info);
    expect($$("a").map((link) => [link.getAttribute("href"), link.getAttribute("rel")])).toEqual([["https://tokama.dev", "noreferrer noopener"]]);
    expect(text(".wn-site")).toBe("tokama.dev↗");
  });

  it("says when there are no notes, when they load and when they could not be read", async () => {
    await history({ appVersion: VERSION, notes: [] });
    expect(text(".placeholder")).toBe("Notes appear here after an update.");
    expect(text(".wn-count")).toBe("0");
    await history(undefined);
    expect(text(".wn-soft")).toBe("Reading the notes…");
    await history("failed");
    expect(text(".wn-soft")).toBe("Could not read the notes.");
  });
});
